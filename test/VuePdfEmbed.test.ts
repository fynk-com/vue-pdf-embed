import { expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import VuePdfEmbed from '../src/VuePdfEmbed.vue'
import PdfPage from '../src/PdfPage.vue'

HTMLCanvasElement.prototype.getContext = () => null

// Minimal DOM APIs used by PdfPage in tests.
// happy-dom doesn't always provide these globals depending on environment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).ResizeObserver ??= class {
  observe() {}
  disconnect() {}
}

vi.mock('pdfjs-dist', () => ({
  // used by useVuePdfEmbed()
  GlobalWorkerOptions: {},
  PasswordResponses: { INCORRECT_PASSWORD: 1 },
  VerbosityLevel: { ERRORS: 0 },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: () => ({
        view: [0, 0, 600, 800],
        rotate: 0,
        getViewport: () => ({
          scale: 1,
          userUnit: 1,
          width: 600,
          height: 800,
          rotation: 0,
          clone: () => ({
            scale: 1,
            userUnit: 1,
            width: 600,
            height: 800,
            rotation: 0,
          }),
        }),
        getAnnotations: () => [],
        getTextContent: () => ({}),
        render: () => ({
          promise: Promise.resolve(),
          cancel: () => {},
        }),
        cleanup: () => {},
      }),
    }),
  }),

  // used by PdfPage.vue (we keep these very small for unit tests)
  TextLayer: class {
    render() {
      return Promise.resolve()
    }
  },
  AnnotationLayer: class {
    constructor() {}
    render() {
      return Promise.resolve()
    }
  },
}))

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  PDFLinkService: class {
    setDocument() {}
    setViewer() {}
  },
}))

test('sets correct data', async () => {
  const wrapper = mount(VuePdfEmbed, {
    props: {
      source: 'SOURCE',
    },
  })
  await flushPromises()
  expect(wrapper.vm.doc).toBeTruthy()
  expect(wrapper.vm.doc?.numPages).toBe(3)
})

test('sets page IDs', async () => {
  const wrapper = mount(VuePdfEmbed, {
    props: {
      id: 'ID',
      source: 'SOURCE',
    },
  })
  await flushPromises()
  expect(wrapper.find('#ID.vue-pdf-embed').exists()).toBe(true)
  expect(wrapper.find('#ID-0.vue-pdf-embed__page').exists()).toBe(false)
  expect(wrapper.find('#ID-1.vue-pdf-embed__page').exists()).toBe(true)
  expect(wrapper.find('#ID-2.vue-pdf-embed__page').exists()).toBe(true)
  expect(wrapper.find('#ID-3.vue-pdf-embed__page').exists()).toBe(true)
  expect(wrapper.find('#ID-4.vue-pdf-embed__page').exists()).toBe(false)
})

test('emits successful events', async () => {
  const wrapper = mount(VuePdfEmbed, {
    props: {
      source: 'SOURCE',
    },
  })
  await flushPromises()
  expect(wrapper.emitted()).toHaveProperty('loaded')
  expect(wrapper.emitted()).toHaveProperty('rendered')
})

test('renders slots content', async () => {
  const wrapper = mount(VuePdfEmbed, {
    props: {
      source: 'SOURCE',
    },
    slots: {
      'after-page': 'AFTER',
      'before-page': 'BEFORE',
    },
  })
  await flushPromises()
  expect(wrapper.html()).toMatch('AFTER')
  expect(wrapper.html()).toMatch('BEFORE')
})

test('sets PDF.js scale CSS variables on page root', async () => {
  const parentRoot = document.createElement('div')
  type ViewportCloneParams = { scale?: number; dontFlip?: boolean }
  const wrapper = mount(PdfPage, {
    props: {
      id: 'ID-1',
      pageNum: 1,
      doc: {
        getPage: async () => ({
          view: [0, 0, 600, 800],
          rotate: 0,
          getViewport: ({
            scale,
            rotation,
          }: {
            scale: number
            rotation: number
          }) => {
            const userUnit = 2
            const width = (600 - 0) * scale * userUnit
            const height = (800 - 0) * scale * userUnit
            return {
              scale,
              userUnit,
              width,
              height,
              rotation,
              clone: ({ scale: nextScale, dontFlip }: ViewportCloneParams) => ({
                scale: nextScale ?? scale,
                userUnit,
                width: (600 - 0) * (nextScale ?? scale) * userUnit,
                height: (800 - 0) * (nextScale ?? scale) * userUnit,
                rotation,
                dontFlip,
              }),
            }
          },
          getAnnotations: async () => [],
          render: () => ({
            promise: Promise.resolve(),
            cancel: () => {},
          }),
          cleanup: () => {},
        }),
      },
      scale: 1,
      rotation: 0,
      annotationLayer: false,
      formLayer: false,
      textLayer: false,
      imageResourcesPath: '',
      width: 300, // ensures deterministic pageScale = 300 / 600 = 0.5
      pagesToRender: [1],
      parentRoot,
    },
    global: {
      provide: {
        linkService: {},
      },
    },
  })

  await flushPromises()
  const el = wrapper.find('.vue-pdf-embed__page').element as HTMLElement
  expect(el.style.getPropertyValue('--scale-factor')).toBe('0.5')
  expect(el.style.getPropertyValue('--user-unit')).toBe('2')
  expect(el.style.getPropertyValue('--total-scale-factor')).toBe('1')
})
