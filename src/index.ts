import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'

import { useVuePdfEmbed } from './composables'
import VuePdfEmbed from './VuePdfEmbed.vue'

if (window?.Vue) {
  window.VuePdfEmbed = VuePdfEmbed
  window.useVuePdfEmbed = useVuePdfEmbed
}

if (!pdfjsLib.GlobalWorkerOptions?.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker
}

export { useVuePdfEmbed }
export default VuePdfEmbed
