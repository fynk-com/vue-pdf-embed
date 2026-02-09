<script setup lang="ts">
import {
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  inject,
  computed,
  shallowRef,
  nextTick,
} from 'vue'
import { AnnotationLayer, TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { emptyElement, releaseCanvas } from './utils'
import type { PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { TextractBlocksApiResponse, TextractBoundingBox } from './types'

interface Props {
  id: string
  pageNum: number
  doc: PDFDocumentProxy | null
  scale: number
  rotation: number
  annotationLayer: boolean
  formLayer: boolean
  textLayer: boolean
  textractBlocks?: TextractBlocksApiResponse | null
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

// Debug logging is intentionally opt-in.
// Enable from a consuming app via any of:
//   - window.__VUE_PDF_EMBED_DEBUG__ = true
//   - localStorage.setItem('vue-pdf-embed:debug', '1')
//   - URL contains ?vue-pdf-embed-debug=1
const isEnabledLogging = false
const getGlobalDebugFlag = (): boolean => {
  try {
    const g = globalThis as unknown as {
      __VUE_PDF_EMBED_DEBUG__?: boolean
      location?: Location
      localStorage?: Storage
    }
    if (g.__VUE_PDF_EMBED_DEBUG__ === true) return true
    if (g.location?.search?.includes('vue-pdf-embed-debug=1')) return true
    if (g.localStorage?.getItem?.('vue-pdf-embed:debug') === '1') return true
  } catch {
    // ignore (SSR/test environments)
  }
  return false
}

const debugEnabled = () => isEnabledLogging || getGlobalDebugFlag()
const debugPrefix = computed(
  () => `[vue-pdf-embed][PdfPage id=${props.id} page=${props.pageNum}]`
)
const debugLog = (...args: unknown[]) => {
  if (!debugEnabled()) return
  // eslint-disable-next-line no-console
  console.log(debugPrefix.value, ...args)
}
const debugGroup = (title: string, details?: Record<string, unknown>) => {
  if (!debugEnabled()) return
  // eslint-disable-next-line no-console
  console.groupCollapsed(`${debugPrefix.value} ${title}`)
  if (details) {
    // eslint-disable-next-line no-console
    console.log(details)
  }
  // eslint-disable-next-line no-console
  console.groupEnd()
}

const pageWidth = ref<number>()
const pageHeight = ref<number>()

const root = shallowRef<HTMLElement | null>(null)
const isVisible = ref(false)
let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
let resizeRaf: number | null = null
let pendingRetryRaf: number | null = null
let renderingTask: { promise: Promise<void>; cancel: () => void } | null = null
let page: PDFPageProxy | null = null
let renderToken = 0
let textLayerRenderToken = 0
let isDestroyed = false
const pageRatio = ref<number | null>(null)

// Inject the linkService from the parent component
const injectedLinkService = inject('linkService') as PDFLinkService

const getContainerElement = (): HTMLElement | null => {
  // Prefer a parent/container element so we can react to layout changes even if
  // the page element itself is temporarily constrained (e.g. mounted in a hidden modal).
  return props.parentRoot ?? root.value?.parentElement ?? root.value
}

const getContainerWidth = (): number => {
  const el = getContainerElement()
  if (!el) {
    debugLog('getContainerWidth: no container element')
    return 0
  }
  // Prefer layout width; fall back to DOMRect for late-mount/layout cases.
  const width = el.clientWidth
  if (width > 0) {
    debugLog('getContainerWidth: clientWidth', { width })
    return width
  }
  const rectWidth = el.getBoundingClientRect().width
  debugLog('getContainerWidth: rectWidth fallback', { rectWidth })
  return rectWidth
}

// Function to get page dimensions
const getPageDimensions = (ratio: number): [number, number] => {
  let width: number
  let height: number

  if (props.height && !props.width) {
    height = props.height
    width = height / ratio
  } else {
    const containerWidth = getContainerWidth()
    // Treat `props.width` as a max width cap (the template uses width: 100% + maxWidth).
    // If the container is narrower, compute the viewport at the container width to avoid
    // relying on CSS downscaling (which breaks scale-sensitive layers).
    if (props.width != null) {
      width =
        containerWidth > 0 ? Math.min(props.width, containerWidth) : props.width
      debugLog('getPageDimensions: width capped', {
        widthProp: props.width,
        containerWidth,
        effectiveWidth: width,
      })
    } else {
      width = containerWidth
      debugLog('getPageDimensions: width from container', { containerWidth })
    }
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

let textractMeasureEl: HTMLSpanElement | null = null
let textractMeasureWidthEl: HTMLSpanElement | null = null
let textractMeasureFontFamily: string | null = null
let textractBaseHeightAt100Px: number | null = null
let textractCanvasCtx: CanvasRenderingContext2D | null = null

const getTextractCanvasCtx = (): CanvasRenderingContext2D | null => {
  if (textractCanvasCtx) return textractCanvasCtx
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof ctx.measureText !== 'function') {
    return null
  }
  textractCanvasCtx = ctx
  return textractCanvasCtx
}

const getTextractFontFamily = (container: HTMLElement): string => {
  // Prefer inheriting from the page container if user styles it.
  // Fallback to a sane default.
  const computed = window.getComputedStyle(container)
  return computed.fontFamily || 'sans-serif'
}

const ensureTextractBaseline = (container: HTMLElement) => {
  const fontFamily = getTextractFontFamily(container)
  if (
    textractMeasureEl &&
    textractMeasureFontFamily === fontFamily &&
    textractBaseHeightAt100Px != null
  ) {
    return
  }

  if (!textractMeasureEl) {
    textractMeasureEl = document.createElement('span')
    textractMeasureEl.style.position = 'absolute'
    textractMeasureEl.style.left = '-99999px'
    textractMeasureEl.style.top = '-99999px'
    textractMeasureEl.style.visibility = 'hidden'
    textractMeasureEl.style.whiteSpace = 'pre'
    textractMeasureEl.style.lineHeight = '1'
    document.body.appendChild(textractMeasureEl)
  }
  if (!textractMeasureWidthEl) {
    textractMeasureWidthEl = document.createElement('span')
    textractMeasureWidthEl.style.position = 'absolute'
    textractMeasureWidthEl.style.left = '-99999px'
    textractMeasureWidthEl.style.top = '-99999px'
    textractMeasureWidthEl.style.visibility = 'hidden'
    textractMeasureWidthEl.style.whiteSpace = 'pre'
    textractMeasureWidthEl.style.lineHeight = '1'
    document.body.appendChild(textractMeasureWidthEl)
  }

  textractMeasureEl.textContent = 'Mg'
  textractMeasureEl.style.fontFamily = fontFamily
  textractMeasureEl.style.fontSize = '100px'

  const rect = textractMeasureEl.getBoundingClientRect()
  // In some test/SSR-like environments this can be 0; fall back later.
  textractBaseHeightAt100Px = rect.height || null
  textractMeasureFontFamily = fontFamily
}

const measureTextractTextWidthPx = ({
  text,
  fontSizePx,
  fontFamily,
}: {
  text: string
  fontSizePx: number
  fontFamily: string
}): number => {
  const ctx = getTextractCanvasCtx()
  if (ctx) {
    ctx.font = `${fontSizePx}px ${fontFamily}`
    return ctx.measureText(text).width
  }

  // Fallback for test/non-canvas environments (e.g. happy-dom).
  if (!textractMeasureWidthEl) {
    textractMeasureWidthEl = document.createElement('span')
    textractMeasureWidthEl.style.position = 'absolute'
    textractMeasureWidthEl.style.left = '-99999px'
    textractMeasureWidthEl.style.top = '-99999px'
    textractMeasureWidthEl.style.visibility = 'hidden'
    textractMeasureWidthEl.style.whiteSpace = 'pre'
    textractMeasureWidthEl.style.lineHeight = '1'
    document.body.appendChild(textractMeasureWidthEl)
  }
  textractMeasureWidthEl.textContent = text
  textractMeasureWidthEl.style.fontFamily = fontFamily
  textractMeasureWidthEl.style.fontSize = `${fontSizePx}px`
  return textractMeasureWidthEl.getBoundingClientRect().width
}

const normalizeRotation = (rotation: number): 0 | 90 | 180 | 270 => {
  const r = ((rotation % 360) + 360) % 360
  if (r === 90 || r === 180 || r === 270) return r
  return 0
}

const mapTextractBBoxForRotation = (
  bbox: TextractBoundingBox,
  rotation: number
): TextractBoundingBox => {
  const rot = normalizeRotation(rotation)
  switch (rot) {
    case 90:
      return {
        Left: 1 - (bbox.Top + bbox.Height),
        Top: bbox.Left,
        Width: bbox.Height,
        Height: bbox.Width,
      }
    case 180:
      return {
        Left: 1 - (bbox.Left + bbox.Width),
        Top: 1 - (bbox.Top + bbox.Height),
        Width: bbox.Width,
        Height: bbox.Height,
      }
    case 270:
      return {
        Left: bbox.Top,
        Top: 1 - (bbox.Left + bbox.Width),
        Width: bbox.Height,
        Height: bbox.Width,
      }
    default:
      return bbox
  }
}

const renderTextractTextLayer = ({
  container,
  textractBlocks,
  pageNum,
  rotation,
}: {
  container: HTMLElement
  textractBlocks: TextractBlocksApiResponse
  pageNum: number
  rotation: number
}) => {
  emptyElement(container)

  const blocks = textractBlocks?.textract_blocks ?? []
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return
  }

  ensureTextractBaseline(container)
  const fontFamily = getTextractFontFamily(container)

  const containerRect = container.getBoundingClientRect()
  const containerWidthPx = containerRect.width || pageWidth.value || 0
  const containerHeightPx = containerRect.height || pageHeight.value || 0

  for (const block of blocks) {
    if (block?.BlockType !== 'LINE') continue
    if (block?.Page !== pageNum) continue
    const text = block?.Text
    const bbox = block?.Geometry?.BoundingBox
    if (!text || !bbox) continue

    const mapped = mapTextractBBoxForRotation(bbox, rotation)

    const targetWidthPx = containerWidthPx * mapped.Width
    const targetHeightPx = containerHeightPx * mapped.Height

    // Derive font-size primarily from height (stable proxy for font size),
    // then fit width with horizontal scaling using fast canvas measurement.
    const baseHeight = textractBaseHeightAt100Px
    let fontSizePx =
      baseHeight && baseHeight > 0 ? (100 * targetHeightPx) / baseHeight : 0
    if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) {
      // Fallback: treat bbox height as font-size in px.
      fontSizePx = Math.max(1, targetHeightPx)
    }

    const measuredWidthPx = measureTextractTextWidthPx({
      text,
      fontSizePx,
      fontFamily,
    })
    let scaleX = measuredWidthPx > 0 ? targetWidthPx / measuredWidthPx : 1
    if (!Number.isFinite(scaleX) || scaleX <= 0) {
      scaleX = 1
    }
    // Clamp to avoid absurd scaling due to bad OCR boxes.
    scaleX = Math.min(10, Math.max(0.1, scaleX))

    const el = document.createElement('span')
    el.textContent = text
    el.style.position = 'absolute'
    el.style.left = `${mapped.Left * 100}%`
    el.style.top = `${mapped.Top * 100}%`
    el.style.width = `${mapped.Width * 100}%`
    el.style.height = `${mapped.Height * 100}%`

    // Keep the text layer selectable but not visually intrusive.
    el.style.color = 'transparent'
    el.style.whiteSpace = 'pre'
    el.style.transformOrigin = '0 0'
    el.style.lineHeight = '1'
    el.style.fontFamily = fontFamily
    el.style.fontSize = `${fontSizePx}px`
    el.style.transform = `scaleX(${scaleX})`

    container.appendChild(el)
  }
}

const renderTextLayerOnly = async () => {
  if (!props.doc || !root.value) return
  if (!props.textLayer) return

  const myToken = ++textLayerRenderToken
  const isStale = () => isDestroyed || myToken !== textLayerRenderToken

  await nextTick()
  if (isStale()) return

  const textLayerDiv = root.value?.querySelector(
    '.textLayer'
  ) as HTMLDivElement | null
  if (!textLayerDiv) return

  // Always clear before re-rendering to avoid duplication.
  emptyElement(textLayerDiv)

  const localPage = page ?? (await props.doc.getPage(props.pageNum))
  if (isStale()) return
  if (!localPage) return

  const pageRotation = ((props.rotation % 360) + localPage.rotate) % 360
  const isTransposed = !!((pageRotation / 90) % 2)
  const viewWidth = (localPage.view[2] || 0) - (localPage.view[0] || 0)
  const viewHeight = (localPage.view[3] || 0) - (localPage.view[1] || 0)
  if (!viewWidth || !viewHeight) return

  const ratio = isTransposed ? viewWidth / viewHeight : viewHeight / viewWidth
  const [actualWidth, actualHeight] = getPageDimensions(ratio)
  if (!actualWidth || !actualHeight) return

  pageRatio.value = ratio
  pageWidth.value = actualWidth
  pageHeight.value = actualHeight

  const pageWidthInPDF = isTransposed ? viewHeight : viewWidth
  const pageScale = actualWidth / pageWidthInPDF
  const viewport = localPage.getViewport({
    scale: pageScale,
    rotation: pageRotation,
  })

  if (props.textractBlocks) {
    renderTextractTextLayer({
      container: textLayerDiv,
      textractBlocks: props.textractBlocks,
      pageNum: props.pageNum,
      rotation: pageRotation,
    })
    return
  }

  const textLayerViewport = viewport.clone({ dontFlip: true })
  const { scale } = viewport
  textLayerDiv.style.setProperty('--total-scale-factor', `${scale}`)
  const textContent = await localPage.getTextContent()
  if (isStale()) return

  await new TextLayer({
    container: textLayerDiv,
    textContentSource: textContent,
    viewport: textLayerViewport,
  }).render()
}

// Function to render the page
const renderPage = async () => {
  if (!props.doc) {
    debugLog('renderPage: no doc')
    return
  }

  const myToken = ++renderToken
  const isStale = () => isDestroyed || myToken !== renderToken

  debugGroup('renderPage:start', {
    token: myToken,
    shouldRender: shouldRender.value,
    containerWidth: getContainerWidth(),
    widthProp: props.width,
    heightProp: props.height,
    scaleProp: props.scale,
    rotationProp: props.rotation,
    pagesToRenderCount: props.pagesToRender?.length,
  })

  try {
    const localPage = await props.doc.getPage(props.pageNum)
    if (isStale()) {
      debugLog('renderPage: stale after getPage', { token: myToken })
      return
    }
    page = localPage
    if (!localPage) return
    const pageRotation = ((props.rotation % 360) + page.rotate) % 360
    // Determine if the page is transposed
    const isTransposed = !!((pageRotation / 90) % 2)
    const viewWidth = (page?.view[2] || 0) - (page?.view[0] || 0)
    const viewHeight = (page?.view[3] || 0) - (page?.view[1] || 0)
    if (!viewWidth || !viewHeight) {
      return
    }
    // Calculate the actual width and height of the page
    const ratio = isTransposed ? viewWidth / viewHeight : viewHeight / viewWidth
    const [actualWidth, actualHeight] = getPageDimensions(ratio)
    if (!actualWidth || !actualHeight) {
      // Late-mount/layout: schedule a single retry next frame.
      // If still 0-width (e.g. modal closed), rely on ResizeObserver (or a later prop change)
      // to trigger the next render attempt rather than looping every frame.
      debugLog('renderPage: missing dimensions, will retry next frame', {
        ratio,
        actualWidth,
        actualHeight,
        containerWidth: getContainerWidth(),
      })
      if (pendingRetryRaf == null) {
        pendingRetryRaf = window.requestAnimationFrame(() => {
          pendingRetryRaf = null
          if (!shouldRender.value) {
            debugLog('renderPage: retry aborted (shouldRender=false)')
            return
          }
          if (getContainerWidth() > 0) {
            debugLog('renderPage: retrying now (containerWidth>0)')
            cleanup()
            renderPage()
          } else {
            debugLog('renderPage: retry skipped (containerWidth still 0)')
          }
        })
      }
      return
    }
    pageRatio.value = ratio

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
      debugLog('renderPage: cancel previous renderingTask')
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
      if (props.textractBlocks) {
        if (isStale()) {
          return
        }
        renderTextractTextLayer({
          container: textLayerDiv,
          textractBlocks: props.textractBlocks,
          pageNum: props.pageNum,
          rotation: pageRotation,
        })
      } else {
        const textLayerViewport = viewport.clone({ dontFlip: true })
        const { scale } = viewport
        textLayerDiv.style.setProperty('--total-scale-factor', `${scale}`)
        const textContent = await localPage.getTextContent()
        if (isStale()) {
          return
        }
        const textLayerRenderTask = new TextLayer({
          container: textLayerDiv,
          textContentSource: textContent,
          viewport: textLayerViewport,
        }).render()
        renderTasks.push(textLayerRenderTask)
      }
    }

    // Render annotation layer if enabled
    if (props.annotationLayer && annotationLayerDiv) {
      const annotationLayerViewport = viewport.clone({ dontFlip: true })
      const annotations = await localPage.getAnnotations({ intent: 'display' })
      if (isStale()) {
        return
      }
      const annotationLayer = new AnnotationLayer({
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        div: annotationLayerDiv,
        page: localPage,
        structTreeLayer: null,
        viewport: annotationLayerViewport,
        commentManager: null,
        linkService: injectedLinkService,
        annotationStorage: null,
      })
      const annotationRenderTask = annotationLayer.render({
        annotations,
        div: annotationLayerDiv,
        imageResourcesPath: props.imageResourcesPath,
        linkService: injectedLinkService,
        page: localPage,
        renderForms: false,
        viewport: annotationLayerViewport,
      })
      renderTasks.push(annotationRenderTask)

      // Scope to this page instance to avoid cross-instance collisions.
      const formLayerDiv = root.value?.querySelector(
        '.formLayer'
      ) as HTMLElement | null
      if (!formLayerDiv) {
        return
      }
      renderFormFields(
        formLayerDiv,
        annotations,
        viewport,
        annotationLayerViewport
      )
    }

    try {
      await Promise.all(renderTasks)
      if (isStale()) {
        debugLog('renderPage: stale after Promise.all', { token: myToken })
        return
      }
      isRendered.value = true
      emit('rendered')
      debugLog('renderPage: done')
    } catch (error) {
      if (isStale()) {
        debugLog('renderPage: stale after error', { token: myToken })
        return
      }
      console.error('Failed to render page:', error)
      handleRenderError(error as Error)
    }
  } catch (error) {
    if (isStale()) {
      return
    }
    console.error('Failed to render page:', error)
    emit('rendering-failed', error as Error)
  }
}

// Function to handle rendering errors
const handleRenderError = (error: Error) => {
  if (error.name === 'RenderingCancelledException') {
    // Rendering was cancelled; no need to do anything
    debugLog('Rendering cancelled:', error.message)
  } else {
    // Emit rendering-failed event for other errors
    emit('rendering-failed', error)
  }
}

// Function to clean up resources when the page is not rendered
const cleanup = () => {
  renderToken++
  textLayerRenderToken++
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
  page = null
}

onMounted(async () => {
  debugGroup('mounted', {
    hasDoc: !!props.doc,
    parentRootPresent: !!props.parentRoot,
    containerWidth: getContainerWidth(),
  })
  if (!props.doc) {
    // Wait for props.doc to be available
    const unwatch = watch(
      () => props.doc,
      (newDoc) => {
        if (newDoc) {
          unwatch()
          debugLog('doc became available; running setup()')
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
    debugLog('setup: missing doc or root', {
      hasDoc: !!props.doc,
      hasRoot: !!root.value,
    })
    return
  }

  // Get the page to calculate dimensions
  try {
    debugGroup('setup:start', {
      containerWidth: getContainerWidth(),
      widthProp: props.width,
      heightProp: props.height,
      parentRootPresent: !!props.parentRoot,
    })
    page = await props.doc.getPage(props.pageNum)
    if (!page) {
      debugLog('setup: getPage returned null')
      return
    }
    const pageRotation = ((props.rotation % 360) + page.rotate) % 360
    const isTransposed = !!((pageRotation / 90) % 2)
    const viewWidth = (page.view[2] || 0) - (page.view[0] || 0)
    const viewHeight = (page.view[3] || 0) - (page.view[1] || 0)
    if (!viewWidth || !viewHeight) {
      return
    }
    const ratio = isTransposed ? viewWidth / viewHeight : viewHeight / viewWidth
    pageRatio.value = ratio
    const [actualWidth, actualHeight] = getPageDimensions(ratio)

    // Update pageWidth/pageHeight only if we have a real container width.
    // If mounted in a hidden container (width = 0), setting pageWidth = 0 would
    // apply maxWidth: 0px in the template and can prevent future resizes from being observed.
    if (actualWidth > 0 && actualHeight > 0) {
      pageWidth.value = actualWidth
      pageHeight.value = actualHeight
    } else {
      pageWidth.value = undefined
      pageHeight.value = undefined
    }
    debugLog('setup: initial dimensions', {
      ratio,
      actualWidth,
      actualHeight,
      containerWidth: getContainerWidth(),
    })

    // Now set up the observer
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        const wasVisible = isVisible.value
        isVisible.value = entry.isIntersecting
        debugLog('IntersectionObserver', {
          isIntersecting: entry.isIntersecting,
          intersectionRatio: entry.intersectionRatio,
          boundingClientRect: {
            w: entry.boundingClientRect.width,
            h: entry.boundingClientRect.height,
          },
        })
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

    // Observe size changes to keep viewport scale in sync with container width.
    resizeObserver?.disconnect()
    resizeObserver = new ResizeObserver(() => {
      // Only relevant when the effective width depends on container width.
      // This is true for:
      // - no explicit sizing props
      // - width provided (treated as max width cap)
      // It's false only when height is explicitly driving layout (height provided, width not).
      const usesContainerWidth = !(props.height && !props.width)
      if (!usesContainerWidth) {
        debugLog('ResizeObserver: skipped (height-driven sizing)', {
          widthProp: props.width,
          heightProp: props.height,
        })
        return
      }
      if (resizeRaf != null) {
        return
      }
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = null

        debugLog('ResizeObserver: tick', {
          containerWidth: getContainerWidth(),
          pageRatio: pageRatio.value,
          shouldRender: shouldRender.value,
        })

        if (pageRatio.value) {
          const [w, h] = getPageDimensions(pageRatio.value)
          if (w && h) {
            pageWidth.value = w
            pageHeight.value = h
            debugLog('ResizeObserver: updated page dims', { w, h })
          }
        }

        if (shouldRender.value) {
          cleanup()
          renderPage()
        }
      })
    })
    const resizeEl = getContainerElement()
    if (resizeEl) {
      debugLog('ResizeObserver: observing element', {
        tag: resizeEl.tagName,
        className: resizeEl.className,
        id: resizeEl.id,
        clientWidth: resizeEl.clientWidth,
        rectWidth: resizeEl.getBoundingClientRect().width,
      })
      resizeObserver.observe(resizeEl)
    }
  } catch (error) {
    console.error('Failed to get page for dimensions:', error)
  }
}

// If the container element arrives/changes after mount (e.g. parent template ref becomes available),
// rebind the ResizeObserver so auto-fit can start reacting immediately.
watch(
  () => props.parentRoot,
  () => {
    const usesContainerWidth = !(props.height && !props.width)
    if (!usesContainerWidth) {
      debugLog('ResizeObserver(rebind): skipped (height-driven sizing)', {
        widthProp: props.width,
        heightProp: props.height,
      })
      return
    }

    const resizeEl = getContainerElement()
    if (!resizeEl) {
      return
    }

    debugLog('parentRoot changed; rebinding ResizeObserver', {
      parentRootPresent: !!props.parentRoot,
      observing: {
        tag: resizeEl.tagName,
        className: resizeEl.className,
        id: resizeEl.id,
        clientWidth: resizeEl.clientWidth,
        rectWidth: resizeEl.getBoundingClientRect().width,
      },
    })

    resizeObserver?.disconnect()
    resizeObserver = new ResizeObserver(() => {
      if (resizeRaf != null) {
        return
      }
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = null

        debugLog('ResizeObserver(rebound): tick', {
          containerWidth: getContainerWidth(),
          pageRatio: pageRatio.value,
          shouldRender: shouldRender.value,
        })

        if (pageRatio.value) {
          const [w, h] = getPageDimensions(pageRatio.value)
          if (w && h) {
            pageWidth.value = w
            pageHeight.value = h
            debugLog('ResizeObserver(rebound): updated page dims', { w, h })
          }
        }

        if (shouldRender.value) {
          cleanup()
          renderPage()
        }
      })
    })
    resizeObserver.observe(resizeEl)
  }
)

onBeforeUnmount(() => {
  isDestroyed = true
  if (observer && root.value) {
    observer.unobserve(root.value)
    observer.disconnect()
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeRaf != null) {
    cancelAnimationFrame(resizeRaf)
    resizeRaf = null
  }
  if (pendingRetryRaf != null) {
    cancelAnimationFrame(pendingRetryRaf)
    pendingRetryRaf = null
  }
  if (textractMeasureEl) {
    textractMeasureEl.remove()
    textractMeasureEl = null
  }
  if (textractMeasureWidthEl) {
    textractMeasureWidthEl.remove()
    textractMeasureWidthEl = null
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

watch(
  () => props.textLayer,
  async (enabled) => {
    if (!shouldRender.value) {
      return
    }

    if (enabled) {
      await renderTextLayerOnly()
      return
    }

    const textLayerDiv = root.value?.querySelector('.textLayer') as HTMLElement
    if (textLayerDiv) {
      emptyElement(textLayerDiv)
    }
  }
)

watch(
  () => props.textractBlocks,
  async () => {
    // If external OCR data arrives/changes while the text layer is enabled,
    // rerender the layer to reflect the new content (override mode).
    if (!shouldRender.value || !props.textLayer) {
      return
    }
    await renderTextLayerOnly()
  }
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
        maxWidth: pageWidth ? pageWidth + 'px' : undefined,
        background: '#FFFFFF',
        width: '100%',
        // Keep stable height early (before we know width) to avoid a 0-height container.
        // pageRatio is height/width, while CSS aspect-ratio expects width/height.
        aspectRatio: pageRatio ? `${1} / ${pageRatio}` : undefined,
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
