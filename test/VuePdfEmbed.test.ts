import { expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import VuePdfEmbed from '../src/VuePdfEmbed.vue'
import PdfPage from '../src/PdfPage.vue'
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'

HTMLCanvasElement.prototype.getContext = () => null

// Minimal DOM APIs used by PdfPage in tests.
// happy-dom doesn't always provide these globals depending on environment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let lastResizeObserverCallback: ResizeObserverCallback | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).ResizeObserver = class {
  constructor(cb: ResizeObserverCallback) {
    lastResizeObserverCallback = cb
  }
  observe() {}
  disconnect() {}
}

const create2dCtx = (): CanvasRenderingContext2D =>
  ({
    clearRect: () => {},
    // Enough for `canvas.measureText()` usage in PdfPage's Textract renderer.
    measureText: (t: string) => ({ width: t.length * 10 }) as TextMetrics,
  }) as unknown as CanvasRenderingContext2D

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
      destroy: () => {},
    }),
    destroy: () => {},
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

test('re-initializes text layer when toggled on', async () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = () => create2dCtx()

  const textLayerRenderSpy = vi.spyOn(TextLayer.prototype, 'render')

  try {
    const parentWidth = 300
    const parentRoot = document.createElement('div')
    Object.defineProperty(parentRoot, 'clientWidth', {
      configurable: true,
      get: () => parentWidth,
    })

    const getPage = vi.fn(async () => ({
      view: [0, 0, 600, 800],
      rotate: 0,
      getViewport: ({ scale }: { scale: number; rotation: number }) => ({
        scale,
        clone: ({ scale: nextScale }: { scale?: number }) => ({
          width: 600 * (nextScale ?? scale),
          height: 800 * (nextScale ?? scale),
          scale: nextScale ?? scale,
        }),
        width: 600 * scale,
        height: 800 * scale,
      }),
      getAnnotations: async () => [],
      getTextContent: vi.fn(async () => ({})),
      render: () => ({
        promise: Promise.resolve(),
        cancel: () => {},
      }),
      cleanup: () => {},
    }))
    const doc = { getPage } as unknown as PDFDocumentProxy

    const wrapper = mount(PdfPage, {
      props: {
        id: 'ID-1',
        pageNum: 1,
        doc,
        scale: 1,
        rotation: 0,
        annotationLayer: false,
        formLayer: false,
        textLayer: false,
        imageResourcesPath: '',
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
    expect(wrapper.find('.textLayer').exists()).toBe(false)

    await wrapper.setProps({ textLayer: true })
    await flushPromises()

    expect(wrapper.find('.textLayer').exists()).toBe(true)
    expect(textLayerRenderSpy).toHaveBeenCalled()
  } finally {
    textLayerRenderSpy.mockRestore()
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }
})

test('renders Textract text layer when provided (override)', async () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = () => create2dCtx()

  const textLayerRenderSpy = vi.spyOn(TextLayer.prototype, 'render')

  try {
    const parentRoot = document.createElement('div')
    Object.defineProperty(parentRoot, 'clientWidth', {
      configurable: true,
      get: () => 300,
    })

    const getPage = vi.fn(async () => ({
      view: [0, 0, 600, 800],
      rotate: 0,
      getViewport: ({ scale }: { scale: number; rotation: number }) => ({
        scale,
        clone: ({ scale: nextScale }: { scale?: number }) => ({
          width: 600 * (nextScale ?? scale),
          height: 800 * (nextScale ?? scale),
          scale: nextScale ?? scale,
        }),
        width: 600 * scale,
        height: 800 * scale,
      }),
      getAnnotations: async () => [],
      getTextContent: vi.fn(async () => ({})),
      render: () => ({
        promise: Promise.resolve(),
        cancel: () => {},
      }),
      cleanup: () => {},
    }))
    const doc = { getPage } as unknown as PDFDocumentProxy

    const wrapper = mount(PdfPage, {
      props: {
        id: 'ID-1',
        pageNum: 1,
        doc,
        scale: 1,
        rotation: 0,
        annotationLayer: false,
        formLayer: false,
        textLayer: true,
        textractBlocks: {
          textract_blocks: [
            {
              BlockType: 'LINE',
              Page: 1,
              Text: 'HELLO_TEXTRACT',
              Geometry: {
                BoundingBox: {
                  Left: 0.1,
                  Top: 0.2,
                  Width: 0.3,
                  Height: 0.05,
                },
              },
            },
          ],
        },
        imageResourcesPath: '',
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

    expect(textLayerRenderSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.textLayer').exists()).toBe(true)
    expect(wrapper.find('.textLayer').element.textContent).toContain(
      'HELLO_TEXTRACT'
    )
  } finally {
    textLayerRenderSpy.mockRestore()
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }
})

test('re-renders page when parent container width changes', async () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = () => create2dCtx()

  try {
    let parentWidth = 300
    const parentRoot = document.createElement('div')
    Object.defineProperty(parentRoot, 'clientWidth', {
      configurable: true,
      get: () => parentWidth,
    })

    const renderSpy = vi.fn(() => ({
      promise: Promise.resolve(),
      cancel: () => {},
    }))

    const getPage = vi.fn(async () => ({
      view: [0, 0, 600, 800],
      rotate: 0,
      getViewport: ({ scale }: { scale: number; rotation: number }) => ({
        scale,
        clone: ({ scale: nextScale }: { scale?: number }) => ({
          width: 600 * (nextScale ?? scale),
          height: 800 * (nextScale ?? scale),
          scale: nextScale ?? scale,
        }),
        width: 600 * scale,
        height: 800 * scale,
      }),
      getAnnotations: async () => [],
      render: renderSpy,
      cleanup: () => {},
    }))
    const doc = { getPage } as unknown as PDFDocumentProxy

    const wrapper = mount(PdfPage, {
      props: {
        id: 'ID-1',
        pageNum: 1,
        doc,
        scale: 1,
        rotation: 0,
        annotationLayer: false,
        formLayer: false,
        textLayer: false,
        imageResourcesPath: '',
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
    const initialGetPageCalls = getPage.mock.calls.length
    const initialRenderCalls = renderSpy.mock.calls.length
    expect(initialGetPageCalls).toBeGreaterThan(0)
    expect(initialRenderCalls).toBeGreaterThan(0)

    // Simulate parent resize and ResizeObserver notification.
    parentWidth = 600
    expect(lastResizeObserverCallback).toBeTruthy()
    lastResizeObserverCallback?.([], {} as unknown as ResizeObserver)

    // rAF throttling: let queued resize work run.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await flushPromises()

    expect(getPage.mock.calls.length).toBeGreaterThan(initialGetPageCalls)
    expect(renderSpy.mock.calls.length).toBeGreaterThan(initialRenderCalls)

    wrapper.unmount()
  } finally {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }
})
