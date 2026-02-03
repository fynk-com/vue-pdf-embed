import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import copy from 'rollup-plugin-copy'
import CleanCSS from 'clean-css'
import type { RollupOptions } from 'rollup'

export const rollupOptions: RollupOptions = {
  external: ['pdfjs-dist', 'vue'],
  output: {
    globals: {
      'pdfjs-dist': 'pdfjsLib',
      vue: 'Vue',
    },
    compact: true,
    inlineDynamicImports: true,
  },
}

export default defineConfig({
  plugins: [
    copy({
      hook: 'writeBundle',
      targets: (['textLayer', 'annotationLayer'] as const).map((key) => ({
        src: 'node_modules/pdfjs-dist/web/pdf_viewer.css',
        dest: 'dist/styles',
        rename: `${key}.css`,
        transform: (contents) => {
          const lines = contents.toString().split('\n')

          const extractBetween = (startRe: RegExp, endRe: RegExp): string => {
            const start = lines.findIndex((l) => startRe.test(l))
            if (start < 0) {
              throw new Error(
                `Failed to find start marker (${startRe}) in pdf_viewer.css`
              )
            }

            const endRel = lines
              .slice(start + 1)
              .findIndex((l) => endRe.test(l))
            const end = endRel < 0 ? lines.length : start + 1 + endRel

            return lines.slice(start, end).join('\n')
          }

          const css =
            key === 'textLayer'
              ? extractBetween(/^\.textLayer\{/, /^\.annotationLayer\{/)
              : extractBetween(/^\.annotationLayer\{/, /^\.xfaLayer\{/)

          return new CleanCSS().minify(css).styles + '\n'
        },
      })),
    }),
    vue(),
  ],
  build: {
    lib: {
      entry: new URL('./src/index.ts', import.meta.url).pathname,
      name: 'VuePdfEmbed',
      fileName: 'index',
    },
    rollupOptions,
  },
})
