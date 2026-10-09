import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerReply, WorkerRequest } from './types.ts'

// prepareFile's decisions (ARCHITECTURE.md §5) with a scripted worker: what is compressed, what is kept
// as the original download-only file, what is refused, and that Cancel stops the worker. The encoders
// themselves (WebCodecs, canvas) are browser-only and are checked by the E2E run and on real phones.

const h = vi.hoisted(() => ({
  script: (_req: WorkerRequest): WorkerReply[] | 'hang' | 'crash' => [],
  workers: [] as { terminated: boolean; requests: WorkerRequest[] }[],
  workerThrows: false,
  release: vi.fn(),
}))

vi.mock('./posterFallback.ts', () => ({
  posterFromVideoElement: vi.fn(async () => null),
  placeholderPoster: vi.fn(async () => ({ blob: new Blob(['ph']), type: 'image/jpeg', width: 400, height: 225 })),
}))
vi.mock('./wakeLock.ts', () => ({ holdScreenAwake: vi.fn(() => h.release) }))
vi.mock('./image.ts', () => ({
  PHOTO_QUALITY: {},
  THUMB_QUALITY: {},
  decodeImage: vi.fn(async () => ({ width: 4000, height: 3000, close: () => {} })),
  encodeScaled: vi.fn(async (_s: unknown, _w: number, _h: number, max: number) => ({
    blob: new Blob(['p'.repeat(max === 400 ? 10 : 100)], { type: 'image/jpeg' }),
    type: 'image/jpeg',
    width: max,
    height: Math.round((max * 3) / 4),
  })),
}))

class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  record = { terminated: false, requests: [] as WorkerRequest[] }
  constructor() {
    if (h.workerThrows) throw new Error('module workers unsupported')
    h.workers.push(this.record)
  }
  postMessage(req: WorkerRequest) {
    this.record.requests.push(req)
    const replies = h.script(req)
    setTimeout(() => {
      if (replies === 'hang') return
      if (replies === 'crash') {
        this.onerror?.({ message: 'out of memory', preventDefault: () => {} } as ErrorEvent)
        return
      }
      for (const r of replies) if (!this.record.terminated) this.onmessage?.({ data: r } as MessageEvent<WorkerReply>)
    }, 0)
  }
  terminate() {
    this.record.terminated = true
  }
}

const img = (type: 'image/webp' | 'image/jpeg', size = 50) => ({ blob: new Blob(['x'.repeat(size)], { type }), type, width: 2048, height: 1536 })
const poster = img('image/webp', 5)
const probe = (over: Partial<{ durationMs: number | null; unsupported: string | null }> = {}): WorkerReply => ({
  type: 'probe',
  probe: { durationMs: 30_000, width: 1920, height: 1080, unsupported: null, poster, ...over },
})

let prepareFile: typeof import('./prepare.ts').prepareFile
let PrepareError: typeof import('./prepare.ts').PrepareError

beforeEach(async () => {
  vi.stubGlobal('Worker', FakeWorker)
  h.workers = []
  h.workerThrows = false
  h.release = vi.fn()
  ;({ prepareFile, PrepareError } = await import('./prepare.ts'))
})
afterEach(() => vi.unstubAllGlobals())

const run = (file: File, signal = new AbortController().signal) => {
  const progress: number[] = []
  return { promise: prepareFile(file, (f) => progress.push(f), signal), progress }
}
const video = (name = 'IMG_0042.MOV', type = 'video/quicktime', bytes = 1000) => new File([new Uint8Array(bytes)], name, { type })

describe('documents', () => {
  it('a PDF goes up as it is, without a worker', async () => {
    const out = await run(new File(['%PDF'], 'quote.pdf', { type: 'application/pdf' })).promise
    expect(out).toMatchObject({ kind: 'document', mimeType: 'application/pdf', name: 'quote.pdf', thumb: null })
    expect(h.workers).toHaveLength(0)
  })
  it('refuses a PDF over 10 MB, an empty file and an unsupported type', async () => {
    await expect(run(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' })).promise).rejects.toThrow(/largest allowed/)
    await expect(run(new File([], 'x.jpg', { type: 'image/jpeg' })).promise).rejects.toThrow('This file is empty.')
    await expect(run(new File(['x'], 'a.docx', { type: 'application/msword' })).promise).rejects.toBeInstanceOf(PrepareError)
  })
})

describe('photos', () => {
  it('uses the worker result and names the file after its new type', async () => {
    h.script = () => [{ type: 'progress', fraction: 0.3 }, { type: 'photo', image: img('image/webp'), thumb: img('image/webp', 5) }]
    const { promise, progress } = run(new File(['jpg'], 'IMG_1.HEIC', { type: 'image/heic' }))
    const out = await promise
    expect(out).toMatchObject({ kind: 'photo', mimeType: 'image/webp', name: 'IMG_1.webp', width: 2048, playable: true, thumb: { type: 'image/webp' } })
    expect(progress).toEqual([0.3, 1])
    expect(h.workers[0].terminated).toBe(true)
  })
  it('falls back to the page when the worker has no OffscreenCanvas, or no worker can start', async () => {
    h.script = () => [{ type: 'error', code: 'unsupported', message: 'no OffscreenCanvas' }]
    expect(await run(new File(['jpg'], 'a.jpg', { type: 'image/jpeg' })).promise).toMatchObject({ mimeType: 'image/jpeg', name: 'a.jpg', width: 2048 })
    h.workerThrows = true
    expect(await run(new File(['jpg'], 'b.png', { type: 'image/png' })).promise).toMatchObject({ mimeType: 'image/jpeg', name: 'b.jpg' })
  })
  it('passes on a picture the browser cannot read', async () => {
    h.script = () => [{ type: 'error', code: 'unreadable', message: 'This picture format cannot be read by this browser.' }]
    await expect(run(new File(['?'], 'a.heic', { type: 'image/heic' })).promise).rejects.toThrow('cannot be read')
  })
  it('refuses an absurdly large picture before decoding it', async () => {
    await expect(run(new File([new Uint8Array(61 * 1024 * 1024)], 'a.jpg', { type: 'image/jpeg' })).promise).rejects.toThrow(/not taken/)
    expect(h.workers).toHaveLength(0)
  })
})

describe('videos', () => {
  it('probes, then compresses to a playable MP4 with the probe poster, holding the screen awake', async () => {
    h.script = (req) =>
      req.op === 'video-probe'
        ? [probe()]
        : [{ type: 'progress', fraction: 0.5 }, { type: 'video', blob: new Blob(['mp4'], { type: 'video/mp4' }), width: 1280, height: 720, durationMs: 30_040, poster: null }]
    const { promise, progress } = run(video())
    const out = await promise
    expect(out).toMatchObject({ kind: 'video', mimeType: 'video/mp4', name: 'IMG_0042.mp4', width: 1280, durationMs: 30_040, playable: true, note: null })
    expect(out.thumb).toEqual({ blob: poster.blob, type: 'image/webp' })
    expect(h.workers.map((w) => w.requests[0].op)).toEqual(['video-probe', 'video-compress'])
    expect(progress).toContain(0.525)
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('refuses a clip over 3 minutes before compressing', async () => {
    h.script = () => [probe({ durationMs: 200_000 })]
    await expect(run(video()).promise).rejects.toThrow(/Trim it to 3 minutes/)
    expect(h.workers).toHaveLength(1)
  })

  it('stores the original download-only when this browser cannot compress, saying why', async () => {
    h.script = () => [probe({ unsupported: 'this browser has no video encoder (WebCodecs)' })]
    const out = await run(video()).promise
    expect(out).toMatchObject({ playable: false, mimeType: 'video/quicktime', name: 'IMG_0042.MOV', durationMs: 30_000 })
    expect(out.note).toContain('no video encoder')
    expect(out.thumb?.type).toBe('image/webp')
  })

  it('falls back to the original when the encoder gives up mid-way, or the worker crashes', async () => {
    h.script = (req) => (req.op === 'video-probe' ? [probe({})] : [{ type: 'error', code: 'unsupported', message: 'this browser cannot convert the sound of this video' }])
    expect(await run(video()).promise).toMatchObject({ playable: false, note: expect.stringContaining('sound') })
    h.script = (req) => (req.op === 'video-probe' ? [probe({})] : 'crash')
    expect(await run(video()).promise).toMatchObject({ playable: false, note: expect.stringContaining('not enough memory') })
  })

  it('a generic encoder failure is an error to retry, not a silent download-only file', async () => {
    h.script = (req) => (req.op === 'video-probe' ? [probe({})] : [{ type: 'error', code: 'failed', message: 'decoder reset' }])
    await expect(run(video()).promise).rejects.toThrow(/could not be compressed \(decoder reset\)/)
  })

  it('without any worker, an unreadable original is refused when too large, stored when it fits', async () => {
    h.workerThrows = true
    await expect(run(video('a.mov', 'video/quicktime', 1)).promise).resolves.toMatchObject({ playable: false })
    await expect(run(new File([new Uint8Array(10)], 'a.mkv', { type: 'video/x-matroska' })).promise).rejects.toThrow(/convert it to MP4/)
  })

  it('Cancel terminates the worker and rejects with AbortError', async () => {
    h.script = (req) => (req.op === 'video-probe' ? [probe()] : 'hang')
    const controller = new AbortController()
    const { promise } = run(video(), controller.signal)
    await vi.waitFor(() => expect(h.workers).toHaveLength(2))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.workers[1].terminated).toBe(true)
    expect(h.release).toHaveBeenCalled()
  })
})
