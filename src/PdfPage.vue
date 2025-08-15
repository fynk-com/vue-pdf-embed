<script setup lang="ts">
import {
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  inject,
  computed,
  shallowRef,
} from 'vue'
import { AnnotationLayer, TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { emptyElement, releaseCanvas } from './utils'
import type { PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs'

interface Props {
  id: string
  pageNum: number
  doc: PDFDocumentProxy | null
  scale: number
  rotation: number
  annotationLayer: boolean
  formLayer: boolean
  textLayer: boolean
  imageResourcesPath: string
  width?: number
  height?: number
  pagesToRender?: number[]
  parentRoot?: HTMLElement | null
}

const props = withDefaults(defineProps<Props>(), {
  pagesToRender: () => [],
})

const emit = defineEmits([
  'internal-link-clicked',
  'rendered',
  'rendering-failed',
  'visibility-changed',
])

const isEnabledLogging = false

const pageWidth = ref<number>()
const pageHeight = ref<number>()

const root = shallowRef<HTMLElement | null>(null)
const isVisible = ref(false)
let observer: IntersectionObserver | null = null
let renderingTask: { promise: Promise<void>; cancel: () => void } | null = null
let page: PDFPageProxy | null = null

// Inject the linkService from the parent component
const linkService = inject('linkService') as PDFLinkService

// Function to get page dimensions
const getPageDimensions = (ratio: number): [number, number] => {
  let width: number
  let height: number

  if (props.height && !props.width) {
    height = props.height
    width = height / ratio
  } else {
    width = props.width ?? props.parentRoot!.clientWidth
    height = width * ratio
  }

  return [width, height]
}

// Computed property to determine if the page should render
const shouldRender = computed(() => {
  return props.pagesToRender?.includes(props.pageNum) ?? false
})

// Function to render form layer
const renderFormFields = (
  formLayerDiv: HTMLElement,
  annotations: {
    rect: number[]
    subtype: string
    fieldName: string
    fieldType: string
    checkBox: boolean
    radioButton: boolean
    combo: boolean
  }[],
  viewport: {
    width: number
    height: number
  },
  annotationLayerViewport: {
    convertToViewportRectangle: (rect: number[]) => number[]
  }
) => {
  const transformedAnnotations = annotations.map((annotation) => {
    const transformedRect = annotationLayerViewport.convertToViewportRectangle(
      annotation.rect
    )
    // Identify form field types
    let fieldCategory = null
    if (annotation.subtype === 'Widget') {
      const fieldType = annotation.fieldType
      switch (fieldType) {
        case 'Tx':
          fieldCategory = 'Text Field'
          break
        case 'Btn':
          if (annotation.checkBox) {
            fieldCategory = 'Checkbox'
          } else if (annotation.radioButton) {
            fieldCategory = 'Radio Button'
          } else {
            fieldCategory = 'Push Button'
          }
          break
        case 'Ch':
          if (annotation.combo) {
            fieldCategory = 'Combo Box'
          } else {
            fieldCategory = 'List Box'
          }
          break
        case 'Sig':
          fieldCategory = 'Signature Field'
          break
        default:
          fieldCategory = 'Unknown Field Type'
      }
    }

    return {
      rect: annotation.rect,
      transformedRect,
      type: annotation.subtype,
      fieldName: annotation.fieldName || null,
      fieldCategory,
      annotation,
    }
  })

  formLayerDiv.innerHTML = ''

  transformedAnnotations.forEach((annotation) => {
    if (annotation.fieldCategory) {
      const [x1, y1, x2, y2] = annotation.transformedRect
      const width = x2 - x1
      const height = y2 - y1

      const formFieldDiv = document.createElement('div')
      formFieldDiv.style.position = 'absolute'
      formFieldDiv.style.left = `${x1}px`
      formFieldDiv.style.top = `${viewport.height - y2}px`
      formFieldDiv.style.width = `${width}px`
      formFieldDiv.style.height = `${height}px`
      formFieldDiv.dataset.fieldName = annotation.fieldName || ''
      formFieldDiv.dataset.fieldCategory = annotation.fieldCategory
      formFieldDiv.classList.add('form-field-overlay')

      // Append to the form layer
      formLayerDiv.appendChild(formFieldDiv)
    }
  })

  // Adjust formLayerDiv dimensions
  formLayerDiv.style.width = `100%`
  formLayerDiv.style.aspectRatio = `${pageWidth.value} / ${pageHeight.value}`
}

const isRendered = ref(false)

// Function to render the page
const renderPage = async () => {
  if (!props.doc || !props.parentRoot) {
    return
  }

  try {
    page = await props.doc.getPage(props.pageNum)
    if (!page) {
      return
    }
    const pageRotation = ((props.rotation % 360) + page.rotate) % 360
    // Determine if the page is transposed
    const isTransposed = !!((pageRotation / 90) % 2)
    const viewWidth = page.view[2] - page.view[0]
    const viewHeight = page.view[3] - page.view[1]
    // Calculate the actual width and height of the page
    const [actualWidth, actualHeight] = getPageDimensions(
      isTransposed ? viewWidth / viewHeight : viewHeight / viewWidth
    )

    // Update pageWidth and pageHeight
    pageWidth.value = actualWidth
    pageHeight.value = actualHeight

    //const cssWidth = `${Math.floor(actualWidth)}px`
    //const cssHeight = `${Math.floor(actualHeight)}px`
    const pageWidthInPDF = isTransposed ? viewHeight : viewWidth
    const pageScale = actualWidth / pageWidthInPDF

    // Calculate viewport with appropriate scale and rotation
    const viewport = page.getViewport({
      scale: pageScale,
      rotation: pageRotation,
    })

    const canvas = root.value?.querySelector('canvas') as HTMLCanvasElement
    const textLayerDiv = root.value?.querySelector(
      '.textLayer'
    ) as HTMLDivElement
    const annotationLayerDiv = root.value?.querySelector(
      '.annotationLayer'
    ) as HTMLDivElement

    if (!canvas) {
      return
    }

    // High-DPI display support
    const outputScale = window.devicePixelRatio || 1
    const adjustedScale = viewport.scale * outputScale * (props.scale || 1)
    const scaledViewport = viewport.clone({ scale: adjustedScale })

    canvas.style.display = 'block'
    //canvas.style.width = cssWidth
    //canvas.style.height = cssHeight

    canvas.width = scaledViewport.width
    canvas.height = scaledViewport.height

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    // Clear the canvas before rendering
    context.clearRect(0, 0, canvas.width, canvas.height)

    // Cancel any previous rendering task
    if (renderingTask) {
      renderingTask.cancel()
      renderingTask = null
    }

    const renderContext = {
      canvas: canvas,
      canvasContext: context,
      viewport: scaledViewport,
    }

    renderingTask = page.render(renderContext)

    const renderTasks = [renderingTask.promise.catch(handleRenderError)]

    // Render text layer if enabled
    if (props.textLayer && textLayerDiv) {
      const textLayerViewport = viewport.clone({ dontFlip: true })
      const { scale } = viewport
      textLayerDiv.style.setProperty('--total-scale-factor', `${scale}`)
      const textLayerRenderTask = new TextLayer({
        container: textLayerDiv,
        textContentSource: await page.getTextContent(),
        viewport: textLayerViewport,
      }).render()
      renderTasks.push(textLayerRenderTask)
    }

    // Render annotation layer if enabled
    if (props.annotationLayer && annotationLayerDiv) {
      const annotationLayerViewport = viewport.clone({ dontFlip: true })
      const annotations = await page.getAnnotations({ intent: 'display' })
      const annotationLayer = new AnnotationLayer({
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        div: annotationLayerDiv,
        page,
        structTreeLayer: null,
        viewport,
      })
      const annotationRenderTask = annotationLayer.render({
        annotations,
        div: annotationLayerDiv,
        imageResourcesPath: props.imageResourcesPath,
        linkService,
        page,
        renderForms: false,
        viewport: annotationLayerViewport,
      })
      renderTasks.push(annotationRenderTask)

      const formLayerDiv = document.querySelector(
        '#' + props.id + ' .formLayer'
      ) as HTMLElement
      renderFormFields(
        formLayerDiv,
        annotations,
        viewport,
        annotationLayerViewport
      )
    }

    try {
      await Promise.all(renderTasks)
      isRendered.value = true
      emit('rendered')
    } catch (error) {
      handleRenderError(error as Error)
    }
  } catch (error) {
    emit('rendering-failed', error as Error)
  }
}

// Function to handle rendering errors
const handleRenderError = (error: Error) => {
  if (error.name === 'RenderingCancelledException') {
    // Rendering was cancelled; no need to do anything
    if (isEnabledLogging) console.log('Rendering cancelled:', error.message)
  } else {
    // Emit rendering-failed event for other errors
    emit('rendering-failed', error)
  }
}

// Function to clean up resources when the page is not rendered
const cleanup = () => {
  isRendered.value = false
  if (renderingTask) {
    renderingTask.cancel()
    renderingTask = null
  }

  // Release canvas
  const canvas = root.value?.querySelector('canvas') as HTMLCanvasElement
  if (canvas) {
    releaseCanvas(canvas)
  }

  // Empty text and annotation layers
  const textLayerDiv = root.value?.querySelector('.textLayer') as HTMLElement
  if (textLayerDiv) {
    emptyElement(textLayerDiv)
  }
  const annotationLayerDiv = root.value?.querySelector(
    '.annotationLayer'
  ) as HTMLElement
  if (annotationLayerDiv) {
    emptyElement(annotationLayerDiv)
  }

  // Clean up page resources
  if (page) {
    page.cleanup()
    page = null
  }
}

onMounted(async () => {
  if (!props.doc) {
    // Wait for props.doc to be available
    const unwatch = watch(
      () => props.doc,
      (newDoc) => {
        if (newDoc) {
          unwatch()
          setup()
        }
      }
    )
  } else {
    setup()
  }
})

const setup = async () => {
  if (!props.doc || !root.value) {
    return
  }

  // Get the page to calculate dimensions
  try {
    page = await props.doc.getPage(props.pageNum)
    if (!page) {
      return
    }
    const pageRotation = ((props.rotation % 360) + page.rotate) % 360
    const isTransposed = !!((pageRotation / 90) % 2)
    const viewWidth = page.view[2] - page.view[0]
    const viewHeight = page.view[3] - page.view[1]
    const ratio = isTransposed ? viewWidth / viewHeight : viewHeight / viewWidth
    const [actualWidth, actualHeight] = getPageDimensions(ratio)

    // Update pageWidth and pageHeight
    pageWidth.value = actualWidth
    pageHeight.value = actualHeight

    // Now set up the observer
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        const wasVisible = isVisible.value
        isVisible.value = entry.isIntersecting
        if (isVisible.value !== wasVisible) {
          emit('visibility-changed', {
            pageNum: props.pageNum,
            isVisible: isVisible.value,
          })
        }
      },
      { root: null, threshold: 0.1 }
    )
    if (root.value) {
      observer.observe(root.value)
    }
  } catch (error) {
    console.error('Failed to get page for dimensions:', error)
  }
}

onBeforeUnmount(() => {
  if (observer && root.value) {
    observer.unobserve(root.value)
    observer.disconnect()
  }
  cleanup()
})

// Watch for changes in relevant props
watch(
  () => [props.scale, props.rotation, props.width, props.height],
  () => {
    // Recalculate dimensions and re-render if needed
    if (shouldRender.value) {
      cleanup()
      renderPage()
    }
  }
)

// Watch shouldRender to render or cleanup accordingly
watch(
  () => shouldRender.value,
  (newValue) => {
    if (newValue) {
      renderPage()
    } else {
      cleanup()
    }
  },
  { immediate: true }
)
</script>

<template>
  <div
    :id="id"
    ref="root"
    class="vue-pdf-embed__page"
    :style="[
      {
        position: 'relative',
        maxWidth: pageWidth + 'px',
        background: '#FFFFFF',
        width: '100%',
        aspectRatio: `${pageWidth} / ${pageHeight}`,
      },
    ]"
  >
    <canvas></canvas>
    <div
      v-if="textLayer"
      class="textLayer"
      :style="{ position: 'absolute', top: 0, left: 0 }"
    ></div>
    <div
      v-if="annotationLayer"
      class="annotationLayer"
      :style="{ position: 'absolute', top: 0, left: 0 }"
    ></div>
    <div
      v-if="formLayer"
      class="formLayer"
      :style="{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }"
    ></div>
    <div
      v-if="!shouldRender"
      class="placeholder"
      :style="{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: '#FFFFFF',
      }"
    ></div>
    <slot v-if="!isRendered" name="page-loader" />
  </div>
</template>

<style scoped>
.vue-pdf-embed__page {
  position: relative;
  overflow: hidden;
}

.vue-pdf-embed__page canvas {
  width: 100%;
  height: 100%;
}

.textLayer,
.annotationLayer {
  width: 100%;
  height: 100%;
}
</style>
