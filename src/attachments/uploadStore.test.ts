import { describe, expect, it, vi } from 'vitest'
import type { PreparedFile } from './media/types.ts'
import { createUploadStore, type UploadDeps, type UploadItem } from './uploadStore.ts'

const TASK = 'task-1'

function prepared(overrides: Partial<PreparedFile> = {}): PreparedFile {
  return {
    kind: 'photo',
    blob: new Blob(['x'.repeat(900)], { type: 'image/webp' }),
    mimeType: 'image/webp',
    name: 'a.webp',
    width: 10,
    height: 10,
    durationMs: null,
    playable: true,
    thumb: { blob: new Blob(['t'.repeat(100)], { type: 'image/jpeg' }), type: 'image/jpeg' },
    note: null,
    ...overrides,
  }
}

function deps(overrides: Partial<UploadDeps> = {}): UploadDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    prepare: vi.fn(async (_file, onProgress) => {
      calls.push('prepare')
      onProgress(0.5)
      return prepared()
    }),
    requestUpload: vi.fn(async (req) => {
      calls.push(`request:${req.kind}:${req.mimeType}:${req.sizeBytes}:${req.thumbMimeType}`)
      return {
        attachmentId: 'att-1',
        upload: { url: 'https://r2/file', headers: { 'Content-Type': req.mimeType } },
        thumbnail: { url: 'https://r2/thumb', headers: { 'Content-Type': req.thumbMimeType } },
      }
    }),
    put: vi.fn(async (request, _body, options) => {
      calls.push(`put:${request.url}`)
      options.onProgress?.(1)
    }),
    confirm: vi.fn(async () => {
      calls.push('confirm')
      return 'ready' as const
    }),
    release: vi.fn(async (id) => {
      calls.push(`release:${id}`)
    }),
    onUploaded: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...overrides,
  }
}

function file(name = 'IMG.jpg', type = 'image/jpeg') {
  return new File(['data'], name, { type })
}

async function settle(store: ReturnType<typeof createUploadStore>) {
  await vi.waitFor(() => expect(store.busy()).toBe(false))
}

const only = (store: ReturnType<typeof createUploadStore>): UploadItem => {
  const items = store.snapshot()
  expect(items).toHaveLength(1)
  return items[0]
}

describe('upload queue', () => {
  it('compresses, reserves, uploads thumbnail then file with the reserved types, confirms', async () => {
    const d = deps()
    const store = createUploadStore(() => d)
    store.add(TASK, [file()])
    await settle(store)
    expect(d.calls).toEqual(['prepare', 'request:photo:image/webp:900:image/jpeg', 'put:https://r2/thumb', 'put:https://r2/file', 'confirm'])
    expect(only(store)).toMatchObject({ stage: 'done', kind: 'photo', fileName: 'a.webp', error: null })
    expect(d.onUploaded).toHaveBeenCalledWith(TASK)
  })

  it('works through several files one at a time, in order', async () => {
    const d = deps()
    const store = createUploadStore(() => d)
    store.add(TASK, [file('1.jpg'), file('2.jpg')])
    expect(store.snapshot().map((i) => i.stage)).toEqual(['waiting', 'waiting'])
    await settle(store)
    expect(d.prepare).toHaveBeenCalledTimes(2)
    expect(store.snapshot().map((i) => i.stage)).toEqual(['done', 'done'])
  })

  it('retries the confirmation while the file "has not arrived" (409 retry), then succeeds', async () => {
    let n = 0
    const d = deps({
      confirm: vi.fn(async () => {
        n += 1
        if (n < 3) throw Object.assign(new Error('not yet'), { name: 'AttachmentFunctionError', retry: true })
        return 'ready' as const
      }),
    })
    const store = createUploadStore(() => d)
    store.add(TASK, [file()])
    await settle(store)
    expect(d.confirm).toHaveBeenCalledTimes(3)
    expect(d.sleep).toHaveBeenCalledTimes(2)
    expect(only(store).stage).toBe('done')
  })

  it('gives up after four confirmation attempts and releases the reservation', async () => {
    const d = deps({ confirm: vi.fn(async () => Promise.reject(Object.assign(new Error('The file has not arrived yet.'), { name: 'AttachmentFunctionError', retry: true }))) })
    const store = createUploadStore(() => d)
    store.add(TASK, [file()])
    await settle(store)
    expect(d.confirm).toHaveBeenCalledTimes(4)
    expect(only(store)).toMatchObject({ stage: 'failed', error: 'The file has not arrived yet.' })
    expect(d.release).toHaveBeenCalledWith('att-1')
  })

  it('a refused reservation fails with the database wording and has nothing to release', async () => {
    const refusal = Object.assign(new Error("The club's storage for videos is full."), { name: 'AttachmentFunctionError' })
    const d = deps({ requestUpload: vi.fn(async () => Promise.reject(refusal)) })
    const store = createUploadStore(() => d)
    store.add(TASK, [file()])
    await settle(store)
    expect(only(store)).toMatchObject({ stage: 'failed', error: "The club's storage for videos is full." })
    expect(d.release).not.toHaveBeenCalled()
  })

  it('a failed PUT releases the reservation; Try again reuses the compressed file', async () => {
    let fail = true
    const d = deps({
      put: vi.fn(async (request) => {
        if (fail && request.url.endsWith('/file')) throw Object.assign(new Error('The upload was interrupted.'), { name: 'PutError' })
      }),
    })
    const store = createUploadStore(() => d)
    store.add(TASK, [file()])
    await settle(store)
    expect(only(store)).toMatchObject({ stage: 'failed', error: 'The upload was interrupted.' })
    expect(d.release).toHaveBeenCalledWith('att-1')
    fail = false
    store.retry(only(store).id)
    await settle(store)
    expect(only(store).stage).toBe('done')
    expect(d.prepare).toHaveBeenCalledTimes(1)
    expect(d.requestUpload).toHaveBeenCalledTimes(2)
  })

  it('an unexpected error is shown with a generic lead-in', async () => {
    const d = deps({ prepare: vi.fn(async () => Promise.reject(new TypeError('boom'))) })
    const store = createUploadStore(() => d)
    store.add(TASK, [file()])
    await settle(store)
    expect(only(store).error).toBe('Something went wrong (boom). Try again.')
  })

  it('a file the database marks failed after confirm is reported, not shown as added', async () => {
    const d = deps({ confirm: vi.fn(async () => 'failed' as const) })
    const store = createUploadStore(() => d)
    store.add(TASK, [file()])
    await settle(store)
    expect(only(store)).toMatchObject({ stage: 'failed' })
    expect(only(store).error).toContain('did not arrive intact')
    expect(d.onUploaded).not.toHaveBeenCalled()
  })

  it('cancel during compression aborts it and ends cancelled; a waiting item is cancelled without running', async () => {
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    const d = deps({
      prepare: vi.fn(
        (_f, _p, signal: AbortSignal) =>
          new Promise<PreparedFile>((_, reject) => {
            started()
            signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))
          }),
      ),
    })
    const store = createUploadStore(() => d)
    store.add(TASK, [file('1.jpg'), file('2.jpg')])
    await startedP
    const [first, second] = store.snapshot()
    store.cancel(second.id)
    store.cancel(first.id)
    await settle(store)
    expect(store.snapshot().map((i) => i.stage)).toEqual(['cancelled', 'cancelled'])
    expect(d.prepare).toHaveBeenCalledTimes(1)
    expect(d.release).not.toHaveBeenCalled()
  })

  it('a note (download-only video) keeps the finished item until dismissed; dismiss refuses running items', async () => {
    const d = deps({ prepare: vi.fn(async () => prepared({ kind: 'video', note: 'Stored as the original file.' })) })
    const store = createUploadStore(() => d)
    store.add(TASK, [file('clip.mov', 'video/quicktime')])
    store.dismiss(only(store).id)
    expect(store.snapshot()).toHaveLength(1)
    await settle(store)
    expect(only(store)).toMatchObject({ stage: 'done', note: 'Stored as the original file.' })
    store.dismiss(only(store).id)
    expect(store.snapshot()).toHaveLength(0)
  })

  it('fails an item when the upload tools cannot be loaded', async () => {
    const store = createUploadStore(() => Promise.reject(new Error('chunk load failed')))
    store.add(TASK, [file()])
    await settle(store)
    expect(only(store).error).toContain('could not be loaded')
  })

  it('notifies subscribers', () => {
    const store = createUploadStore(() => deps())
    const listener = vi.fn()
    const off = store.subscribe(listener)
    store.add(TASK, [file()])
    expect(listener).toHaveBeenCalled()
    off()
  })
})
