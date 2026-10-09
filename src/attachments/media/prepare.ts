import { MAX_BYTES, MAX_PHOTO_INPUT_BYTES, PHOTO_MAX_SIDE, THUMB_MAX_SIDE, classifyFile, displayName, formatBytes, planVideo, storableVideoType } from '../rules.ts'
import { PHOTO_QUALITY, THUMB_QUALITY, decodeImage, encodeScaled } from './image.ts'
import { placeholderPoster, posterFromVideoElement } from './posterFallback.ts'
import type { EncodedImage, PreparedFile, VideoProbe, WorkerReply, WorkerRequest } from './types.ts'
import { holdScreenAwake } from './wakeLock.ts'

// The page side of compression (loaded only when a file is picked — ATT-18). Turns a picked file into
// what is uploaded: photos re-encoded and shrunk, videos compressed or, when this browser cannot, kept as
// the original download-only file (ARCHITECTURE.md §5, OQ-3 default). Heavy work runs in a worker.

export class PrepareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrepareError'
  }
}

type Hooks = { onProgress: (fraction: number) => void; signal: AbortSignal }

class WorkerUnavailable extends Error {}

function runWorker(request: WorkerRequest, hooks: Hooks): Promise<Exclude<WorkerReply, { type: 'progress' }>> {
  return new Promise((resolve, reject) => {
    if (hooks.signal.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'))
      return
    }
    let worker: Worker
    try {
      worker = new Worker(new URL('./compress.worker.ts', import.meta.url), { type: 'module' })
    } catch (e) {
      reject(new WorkerUnavailable(String(e)))
      return
    }
    const finish = () => {
      hooks.signal.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = () => {
      finish()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    hooks.signal.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data
      if (reply.type === 'progress') {
        hooks.onProgress(reply.fraction)
        return
      }
      finish()
      resolve(reply)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish()
      // A worker that never started (module workers unsupported) and one that crashed (out of memory on a
      // long 4K clip) look alike from here; both are reported as "could not compress".
      reject(new WorkerUnavailable(event.message || 'worker failed'))
    }
    worker.postMessage(request)
  })
}

function scaled(hooks: Hooks, from: number, to: number): Hooks {
  return { ...hooks, onProgress: (f) => hooks.onProgress(from + (to - from) * f) }
}

// ------------------------------------------------------------------------------- photos
async function photoOnPage(file: File): Promise<{ image: EncodedImage; thumb: EncodedImage }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await decodeImage(file)
  } catch {
    throw new PrepareError('This picture format cannot be read by this browser. Save it as JPEG or PNG, or pick it again from the photo library.')
  }
  try {
    const image = await encodeScaled(bitmap, bitmap.width, bitmap.height, PHOTO_MAX_SIDE, PHOTO_QUALITY)
    const thumb = await encodeScaled(bitmap, bitmap.width, bitmap.height, THUMB_MAX_SIDE, THUMB_QUALITY)
    return { image, thumb }
  } finally {
    bitmap.close()
  }
}

async function preparePhoto(file: File, hooks: Hooks): Promise<PreparedFile> {
  if (file.size > MAX_PHOTO_INPUT_BYTES) {
    throw new PrepareError(`This picture is ${formatBytes(file.size)}; pictures over ${formatBytes(MAX_PHOTO_INPUT_BYTES)} are not taken. Export a smaller copy first.`)
  }
  let result: { image: EncodedImage; thumb: EncodedImage }
  try {
    const reply = await runWorker({ op: 'photo', file }, hooks)
    if (reply.type === 'photo') result = reply
    else if (reply.type === 'error' && reply.code === 'unsupported') result = await photoOnPage(file)
    else throw new PrepareError(reply.type === 'error' ? reply.message : 'The picture could not be prepared.')
  } catch (e) {
    if (!(e instanceof WorkerUnavailable)) throw e
    result = await photoOnPage(file)
  }
  if (result.image.blob.size > MAX_BYTES.photo) throw new PrepareError('Even compressed, this picture is over 10 MB.')
  hooks.onProgress(1)
  return {
    kind: 'photo',
    blob: result.image.blob,
    mimeType: result.image.type,
    name: displayName(file.name, result.image.type === 'image/webp' ? 'webp' : 'jpg'),
    width: result.image.width,
    height: result.image.height,
    durationMs: null,
    playable: true,
    thumb: { blob: result.thumb.blob, type: result.thumb.type },
    note: null,
  }
}

// ------------------------------------------------------------------------------- videos
const NO_PROBE: VideoProbe = { durationMs: null, width: null, height: null, unsupported: 'this browser cannot compress video here', poster: null }

async function probe(file: File, hooks: Hooks): Promise<VideoProbe> {
  try {
    const reply = await runWorker({ op: 'video-probe', file }, hooks)
    return reply.type === 'probe' ? reply.probe : { ...NO_PROBE, unsupported: reply.type === 'error' ? reply.message : NO_PROBE.unsupported }
  } catch (e) {
    if (e instanceof WorkerUnavailable) return NO_PROBE
    throw e
  }
}

async function storeOriginal(file: File, info: VideoProbe, mimeType: string, reason: string): Promise<PreparedFile> {
  const poster = info.poster ?? (await posterFromVideoElement(file)) ?? (await placeholderPoster())
  return {
    kind: 'video',
    blob: file,
    mimeType,
    name: displayName(file.name),
    width: info.width,
    height: info.height,
    durationMs: info.durationMs,
    playable: false,
    thumb: { blob: poster.blob, type: poster.type },
    note: `Stored as the original file, download only: ${reason}. Uploading from an up-to-date phone, Chrome, Edge or Safari makes it playable in the app.`,
  }
}

async function prepareVideo(file: File, hooks: Hooks): Promise<PreparedFile> {
  const info = await probe(file, scaled(hooks, 0, 0.05))
  const storableType = storableVideoType(file)
  const plan = planVideo({ canCompress: info.unsupported === null, durationMs: info.durationMs, sizeBytes: file.size, storableType })
  if (plan.action === 'refuse') throw new PrepareError(plan.message)
  if (plan.action === 'store-original') return storeOriginal(file, info, plan.mimeType, info.unsupported ?? 'it could not be compressed')

  const release = holdScreenAwake()
  try {
    const reply = await runWorker({ op: 'video-compress', file }, scaled(hooks, 0.05, 1))
    if (reply.type === 'video') {
      if (reply.blob.size > MAX_BYTES.video) throw new PrepareError('Even compressed, this video is over 100 MB. Trim it and add it again.')
      const poster = info.poster ?? (await placeholderPoster())
      return {
        kind: 'video',
        blob: reply.blob,
        mimeType: 'video/mp4',
        name: displayName(file.name, 'mp4'),
        width: reply.width,
        height: reply.height,
        durationMs: reply.durationMs,
        playable: true,
        thumb: { blob: poster.blob, type: poster.type },
        note: null,
      }
    }
    const reason = reply.type === 'error' ? reply.message : 'it could not be compressed'
    // The probe said yes but the encoder gave up (a codec quirk, memory): keep the original if allowed.
    const fallback = planVideo({ canCompress: false, durationMs: info.durationMs, sizeBytes: file.size, storableType })
    if (fallback.action === 'store-original' && (reply.type !== 'error' || reply.code === 'unsupported')) {
      return storeOriginal(file, info, fallback.mimeType, reason)
    }
    throw new PrepareError(
      fallback.action === 'refuse' ? fallback.message : `The video could not be compressed (${reason}). Try again, or keep this screen open while it works.`,
    )
  } catch (e) {
    if (!(e instanceof WorkerUnavailable)) throw e
    const fallback = planVideo({ canCompress: false, durationMs: info.durationMs, sizeBytes: file.size, storableType })
    if (fallback.action !== 'store-original') throw new PrepareError(fallback.action === 'refuse' ? fallback.message : 'The video could not be compressed.')
    return storeOriginal(file, info, fallback.mimeType, 'the compressor stopped (often: not enough memory on this device)')
  } finally {
    release()
  }
}

// --------------------------------------------------------------------------- documents
function prepareDocument(file: File): PreparedFile {
  if (file.size > MAX_BYTES.document) {
    throw new PrepareError(`This PDF is ${formatBytes(file.size)}; the largest allowed is ${formatBytes(MAX_BYTES.document)}. Compress it first.`)
  }
  return {
    kind: 'document',
    blob: file,
    mimeType: 'application/pdf',
    name: displayName(file.name),
    width: null,
    height: null,
    durationMs: null,
    playable: true,
    thumb: null,
    note: null,
  }
}

export async function prepareFile(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<PreparedFile> {
  const kind = classifyFile(file)
  if (kind === null) throw new PrepareError('Only photos, videos and PDF files can be attached.')
  if (file.size === 0) throw new PrepareError('This file is empty.')
  const hooks = { onProgress, signal }
  if (kind === 'document') return prepareDocument(file)
  if (kind === 'photo') return preparePhoto(file, hooks)
  return prepareVideo(file, hooks)
}
