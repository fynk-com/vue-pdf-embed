import workerSrc from 'pdfjs-dist/build/pdf.worker?worker&url'
import * as pdfjs from 'pdfjs-dist'

import { useVuePdfEmbed } from './composables'
import VuePdfEmbed from './VuePdfEmbed.vue'

if (window?.Vue) {
  window.VuePdfEmbed = VuePdfEmbed
  window.useVuePdfEmbed = useVuePdfEmbed
}

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

export { useVuePdfEmbed }
export default VuePdfEmbed
