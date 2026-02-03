import { expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import VuePdfEmbed from '../src/VuePdfEmbed.vue'

HTMLCanvasElement.prototype.getContext = () => null

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  PasswordResponses: { INCORRECT_PASSWORD: 1 },
  VerbosityLevel: { ERRORS: 0 },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: async () => ({
        view: [],
        rotate: 0,
        getViewport: () => ({
          scale: 1,
          clone: () => ({}),
        }),
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
