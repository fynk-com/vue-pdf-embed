<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  provide,
  shallowRef,
  toRef,
  ref,
  watch,
  type Ref,
} from 'vue'
import { PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { OnProgressParameters, PDFDocumentProxy } from 'pdfjs-dist'

import type { PasswordRequestParams, Source } from './types'
import {
  addPrintStyles,
  createPrintIframe,
  downloadPdf,
  releaseChildCanvases,
} from './utils'
import { useVuePdfEmbed } from './composables'
import PdfPage from './PdfPage.vue'

const props = withDefaults(
  defineProps<{
    /**
     * Whether to enable an annotation layer.
     */
    annotationLayer: boolean
    /**
     * Whether to enable a form layer.
     */
    formLayer?: boolean
    /**
     * Desired page height.
     */
    height?: number
    /**
     * Root element identifier (inherited by page containers with page number
     * postfixes).
     */
    id: string
    /**
     * Path for annotation icons, including trailing slash.
     */
    imageResourcesPath: string
    /**
     * Document navigation service.
     */
    linkService?: PDFLinkService
    /**
     * Number of the page to display.
     */
    page?: number
    /**
     * Desired page rotation angle.
     */
    rotation?: number
    /**
     * Desired ratio of canvas size to document size.
     */
    scale?: number
    /**
     * Source of the document to display.
     */
    source: Source
    /**
     * Whether to enable a text layer.
     */
    textLayer: boolean
    /**
     * Desired page width.
     */
    width?: number
  }>(),
  {
    rotation: 0,
    scale: 1,
    formLayer: false,
  }
)

const height = computed(() => props.height ?? undefined)
const width = computed(() => props.width ?? undefined)

const emit = defineEmits<{
  (e: 'internal-link-clicked', value: number): void
  (e: 'loaded', value: PDFDocumentProxy): void
  (e: 'loading-failed', value: Error): void
  (e: 'password-requested', value: PasswordRequestParams): void
  (e: 'progress', value: OnProgressParameters): void
  (e: 'rendered'): void
  (e: 'page-rendered'): void
  (e: 'rendering-failed', value: Error): void
}>()

const root = shallowRef<HTMLDivElement | null>(null)

// Initialize doc using the custom composable
const { doc } = useVuePdfEmbed({
  onError: (e) => {
    emit('loading-failed', e)
  },
  onPasswordRequest({ callback, isWrongPassword }) {
    emit('password-requested', { callback, isWrongPassword });
  },
  onProgress: (progressParams) => {
    emit('progress', progressParams)
  },
  source: toRef(props, 'source'),
}) as { doc: Ref<PDFDocumentProxy> }

// Reactive variable to hold page numbers
const pageNums = ref<number[]>([])

// Watch for doc changes to initialize pageNums
watch(
  doc,
  (newDoc) => {
    if (newDoc) {
      if (props.page) {
        pageNums.value = [props.page]
      } else {
        pageNums.value = Array.from(
          { length: newDoc.numPages },
          (_, i) => i + 1
        )
      }
      emit('loaded', newDoc)
    } else {
      pageNums.value = []
    }
  },
  { immediate: true }
)

const onPageRendered = () => {
  emit('page-rendered')
}

const onRenderingFailed = (e: Error) => {
  emit('rendering-failed', e)
}

const linkService = computed(() => {
  if (!doc.value || !props.annotationLayer) {
    return null
  } else if (props.linkService) {
    return props.linkService
  }

  const service = new PDFLinkService()
  service.setDocument(doc.value)
  service.setViewer({
    scrollPageIntoView: ({ pageNumber }: { pageNumber: number }) => {
      emit('internal-link-clicked', pageNumber)
    },
  })
  return service
})

// Provide the linkService to child components
provide('linkService', linkService.value)

const handleInternalLinkClick = (pageNumber: number) => {
  console.log(`Internal link clicked: ${pageNumber}`)
  // Implement page navigation logic
  // For example, scroll to the page or update the current page prop
}

/**
 * Downloads the PDF document.
 * @param filename - Predefined filename to save.
 */
const download = async (filename: string) => {
  if (!doc.value) {
    return
  }

  const data = await doc.value.getData()
  const metadata = await doc.value.getMetadata()
  const suggestedFilename =
    // @ts-expect-error: contentDispositionFilename is not typed
    filename ?? metadata.contentDispositionFilename ?? ''
  downloadPdf(data, suggestedFilename)
}

/**
 * Prints a PDF document via the browser interface.
 * @param dpi - Print resolution.
 * @param filename - Predefined filename to save.
 * @param allPages - Whether to ignore the page prop and print all pages.
 */
const print = async (dpi = 300, filename = '', allPages = false) => {
  if (!doc.value) {
    return
  }

  const printUnits = dpi / 72
  const styleUnits = 96 / 72
  let container: HTMLDivElement
  let iframe: HTMLIFrameElement
  let title: string | undefined

  try {
    container = window.document.createElement('div')
    container.style.display = 'none'
    window.document.body.appendChild(container)
    iframe = await createPrintIframe(container)

    const pageNums =
      props.page && !allPages
        ? [props.page]
        : [...Array(doc.value.numPages + 1).keys()].slice(1)

    await Promise.all(
      pageNums.map(async (pageNum, i) => {
        const page = await doc.value!.getPage(pageNum)
        const viewport = page.getViewport({
          scale: 1,
          rotation: 0,
        })

        if (i === 0) {
          const sizeX = (viewport.width * printUnits) / styleUnits
          const sizeY = (viewport.height * printUnits) / styleUnits
          addPrintStyles(iframe, sizeX, sizeY)
        }

        const canvas = window.document.createElement('canvas')
        canvas.width = viewport.width * printUnits
        canvas.height = viewport.height * printUnits
        container.appendChild(canvas)
        const canvasClone = canvas.cloneNode() as HTMLCanvasElement
        iframe.contentWindow!.document.body.appendChild(canvasClone)

        await page.render({
          canvasContext: canvas.getContext('2d')!,
          intent: 'print',
          transform: [printUnits, 0, 0, printUnits, 0, 0],
          viewport,
        }).promise

        canvasClone.getContext('2d')!.drawImage(canvas, 0, 0)
      })
    )

    if (filename) {
      title = window.document.title
      window.document.title = filename
    }

    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
  } finally {
    if (title) {
      window.document.title = title
    }

    releaseChildCanvases(container!)
    container!.parentNode?.removeChild(container!)
  }
}

onBeforeUnmount(() => {
  releaseChildCanvases(root.value)
})

// Define the pagesToRender array
const pagesToRender = ref<number[]>([])
// Define a Set to keep track of visible pages
const visiblePages = new Set<number>()

// Handler for visibility-changed events
const onVisibilityChanged = ({
  pageNum,
  isVisible,
}: {
  pageNum: number
  isVisible: boolean
}) => {
  if (isVisible) {
    visiblePages.add(pageNum)
  } else {
    visiblePages.delete(pageNum)
  }

  // Recalculate pagesToRender
  const newPagesToRender = new Set<number>()
  visiblePages.forEach((visiblePageNum) => {
    const pages = [
      visiblePageNum - 1,
      visiblePageNum,
      visiblePageNum + 1,
    ].filter((num) => num > 0 && doc.value && num <= doc.value.numPages)
    pages.forEach((num) => newPagesToRender.add(num))
  })
  pagesToRender.value = Array.from(newPagesToRender)
}

// Initial render event after pageNums is first set
watch(
  pageNums,
  () => {
    if (pageNums.value.length > 0) {
      emit('rendered')
    }
  },
  { immediate: true }
)

defineExpose({
  doc,
  download,
  print,
})
</script>

<template>
  <div :id="id" ref="root" class="vue-pdf-embed">
    <div v-for="pageNum in pageNums" :key="pageNum">
      <slot name="before-page" :page="pageNum" />

      <PdfPage
        :id="id && `${id}-${pageNum}`"
        :page-num="pageNum"
        :doc="doc"
        :scale="scale"
        :rotation="rotation"
        :width="width"
        :height="height"
        :annotation-layer="annotationLayer"
        :form-layer="formLayer"
        :text-layer="textLayer"
        :image-resources-path="imageResourcesPath"
        :pages-to-render="pagesToRender"
        :parent-root="root"
        @internal-link-clicked="handleInternalLinkClick"
        @rendered="onPageRendered"
        @rendering-failed="onRenderingFailed"
        @visibility-changed="onVisibilityChanged"
      />

      <slot name="after-page" :page="pageNum" />
    </div>
  </div>
</template>
