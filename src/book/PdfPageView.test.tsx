import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The pdf.js page view over a fake pdf.js: which document is opened, which
// page is drawn, that a newer page cancels an unfinished drawing, and that
// closing the reader (or changing document) destroys the loading task, which
// is what releases pdf.js's worker. A real browser run draws the real PDF.
type Task = { url: string; promise: Promise<unknown>; resolve: (doc: unknown) => void; reject: (e: Error) => void; destroy: ReturnType<typeof vi.fn> }
const fake = vi.hoisted(() => ({
  tasks: [] as unknown[],
  renders: [] as { page: number; cancel: ReturnType<typeof vi.fn> }[],
  hold: false,
  getPageError: null as Error | null,
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: ({ url }: { url: string }) => {
    let resolve!: (doc: unknown) => void
    let reject!: (e: Error) => void
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    const task = { url, promise, resolve, reject, destroy: vi.fn(async () => {}) }
    fake.tasks.push(task)
    return task
  },
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.js' }))

const { default: PdfPageView } = await import('./PdfPageView.tsx')

const tasks = () => fake.tasks as Task[]
const doc = (numPages: number) => ({
  numPages,
  getPage: vi.fn(async (page: number) => {
    if (fake.getPageError) throw fake.getPageError
    return {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 840 * scale }),
      render: () => {
        const cancel = vi.fn()
        fake.renders.push({ page, cancel })
        return { cancel, promise: fake.hold ? new Promise(() => {}) : Promise.resolve() }
      },
    }
  }),
})

class FakeResizeObserver {
  private cb: (entries: { contentRect: { width: number } }[]) => void
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
    this.cb = cb
  }
  observe() {
    queueMicrotask(() => this.cb([{ contentRect: { width: 600 } }]))
  }
  disconnect() {}
}

const props = (over: Partial<Parameters<typeof PdfPageView>[0]> = {}) => ({
  url: 'blob:book-1', pageIndex: 3, label: 'Book page 3', onDocument: vi.fn(), onError: vi.fn(), ...over,
})
const box = () => screen.getByTestId('book-canvas-box')

beforeEach(() => {
  fake.tasks = []
  fake.renders = []
  fake.hold = false
  fake.getPageError = null
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})
afterEach(() => vi.unstubAllGlobals())

describe('PdfPageView', () => {
  it('opens the document once, draws the requested page, and says which page it drew', async () => {
    const p = props()
    render(<PdfPageView {...p} />)
    expect(screen.getByText('Opening the document…')).toBeInTheDocument()
    await act(async () => tasks()[0].resolve(doc(10)))
    await waitFor(() => expect(box()).toHaveAttribute('data-rendered-page', '3'))
    expect(p.onDocument).toHaveBeenCalledWith(10)
    expect(tasks()).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Book page 3' })).toBeInTheDocument()
  })

  it('turns to another page in the SAME open document, cancelling an unfinished drawing', async () => {
    fake.hold = true
    const p = props()
    const view = render(<PdfPageView {...p} />)
    await act(async () => tasks()[0].resolve(doc(10)))
    await waitFor(() => expect(fake.renders.map((r) => r.page)).toEqual([3]))
    fake.hold = false
    view.rerender(<PdfPageView {...p} pageIndex={7} />)
    await waitFor(() => expect(box()).toHaveAttribute('data-rendered-page', '7'))
    expect(fake.renders[0].cancel).toHaveBeenCalled()
    // No second document was opened.
    expect(tasks()).toHaveLength(1)
  })

  it('never asks for a page beyond the document', async () => {
    render(<PdfPageView {...props({ pageIndex: 99 })} />)
    await act(async () => tasks()[0].resolve(doc(10)))
    await waitFor(() => expect(box()).toHaveAttribute('data-rendered-page', '10'))
  })

  it('reports a document that cannot be opened, and a page that cannot be read', async () => {
    const p = props()
    render(<PdfPageView {...p} />)
    await act(async () => tasks()[0].reject(new Error('Invalid PDF structure')))
    expect(p.onError).toHaveBeenCalledWith('Invalid PDF structure')

    fake.getPageError = new Error('page gone')
    const q = props({ url: 'blob:book-2' })
    render(<PdfPageView {...q} />)
    await act(async () => tasks()[1].resolve(doc(10)))
    await waitFor(() => expect(q.onError).toHaveBeenCalledWith('page gone'))
  })

  it('destroys the loading task (releasing the worker) when closed, or when the document changes', async () => {
    const p = props()
    const view = render(<PdfPageView {...p} />)
    await act(async () => tasks()[0].resolve(doc(10)))
    view.rerender(<PdfPageView {...p} url="blob:book-other" />)
    expect(tasks()[0].destroy).toHaveBeenCalledTimes(1)
    expect(tasks()[1].url).toBe('blob:book-other')
    view.unmount()
    expect(tasks()[1].destroy).toHaveBeenCalledTimes(1)
  })
})
