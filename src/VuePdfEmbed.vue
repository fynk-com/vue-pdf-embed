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

// Define your DocumentSection interface
export interface DocumentSection {
  first_page: number
  last_page: number
  label: string
  title: string
}

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
     * Root element identifier (inherited by page containers).
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
     * Number of the page to display (single-page mode).
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
    /**
     * The section to display.
     */
    activeSection?: DocumentSection
    /**
     * The sections of the document.
     */
    sections?: DocumentSection[]
    /**
     * Whether to show the section title even if there is an active section.
     */
    alwaysShowSectionTitles?: boolean
  }>(),
  {
    rotation: 0,
    scale: 1,
    formLayer: false,
    alwaysShowSectionTitles: false,
    sectionTitleStyles: '',
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
    emit('password-requested', { callback, isWrongPassword })
  },
  onProgress: (progressParams) => {
    emit('progress', progressParams)
  },
  source: toRef(props, 'source'),
}) as { doc: Ref<PDFDocumentProxy> }

// ----------------------------------------
// 1) DEFINE A COMPUTED ARRAY OF PAGE NUMBERS
//    to display based on either:
//    - single page (props.page)
//    - a section (props.activeSection)
//    - or the entire doc
// ----------------------------------------
const pageNums = computed<number[]>(() => {
  if (!doc.value) {
    return []
  }

  // If single-page mode, use that single page
  if (props.page) {
    return [props.page]
  }

  // If a specific section is active, use its page range
  if (props.activeSection) {
    const start = props.activeSection.first_page
    const end = Math.min(props.activeSection.last_page, doc.value.numPages)
    const pages: number[] = []
    for (let p = start; p <= end; p++) {
      pages.push(p)
    }
    return pages
  }

  // Otherwise, display the entire document
  return Array.from({ length: doc.value.numPages }, (_, i) => i + 1)
})

// ----------------------------------------
// 2) EMIT 'LOADED' WHEN THE DOCUMENT IS READY
// ----------------------------------------
watch(
  doc,
  (newDoc) => {
    if (newDoc) {
      emit('loaded', newDoc)
    }
  },
  { immediate: true }
)

// ----------------------------------------
// 3) EMIT 'rendered' ONCE WHEN WE ACTUALLY
//    HAVE SOME PAGES TO SHOW
// ----------------------------------------
watch(
  () => pageNums.value,
  (newVal) => {
    if (newVal.length > 0) {
      emit('rendered')
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
  // Implement page navigation logic if you want
  // For now, just log the page number or emit an event
  console.log(`Internal link clicked: ${pageNumber}`)
}

/**
 * Downloads the PDF document.
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

    const pageNumbersToPrint =
      props.page && !allPages
        ? [props.page]
        : Array.from({ length: doc.value.numPages }, (_, i) => i + 1)

    await Promise.all(
      pageNumbersToPrint.map(async (pageNum, i) => {
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
          canvas: canvas,
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

// Rendering optimization variables
const pagesToRender = ref<number[]>([])
const visiblePages = new Set<number>()

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

  // Recalculate pagesToRender around visible pages
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

// ----------------------------------------
// 4) HELPER FOR SECTION TITLES
//    Only show if we are *not* in single-section mode
// ----------------------------------------
const findSectionForPage = (pageNum: number): DocumentSection | undefined => {
  return props.sections?.find((section) => section.first_page === pageNum)
}

const shouldShowSectionTitle = (pageNum: number): boolean => {
  // Only show section headers if there is no activeSection
  // (meaning we are displaying multiple or all sections)
  if (props.activeSection && !props.alwaysShowSectionTitles) return false
  // Show a header if this page is the first page of some section
  return Boolean(findSectionForPage(pageNum))
}

defineExpose({
  doc,
  download,
  print,
})
</script>

<template>
  <div :id="id" ref="root" class="vue-pdf-embed">
    <!-- Render the (computed) pageNums -->
    <div v-for="pageNum in pageNums" :key="pageNum">
      <!-- Conditionally show the section title if it's the start of a section
           AND no activeSection is selected. -->
      <slot
        v-if="shouldShowSectionTitle(pageNum)"
        name="section-title"
        :title="findSectionForPage(pageNum)?.title"
        :label="findSectionForPage(pageNum)?.label"
        class="flex items-center"
      />

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
      >
        <template #page-loader>
          <slot name="page-loader" />
        </template>
      </PdfPage>

      <slot name="after-page" :page="pageNum" />
    </div>
  </div>
</template>
