import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker'
pdfjsLib.GlobalWorkerOptions.workerPort = new pdfjsWorker()

import { useVuePdfEmbed } from './composables'
import VuePdfEmbed from './VuePdfEmbed.vue'

if (window?.Vue) {
  window.VuePdfEmbed = VuePdfEmbed
  window.useVuePdfEmbed = useVuePdfEmbed
}

export { useVuePdfEmbed }
export default VuePdfEmbed
