/// <reference lib="webworker" />
import { PHOTO_MAX_SIDE, MAX_BYTES, THUMB_MAX_SIDE } from '../rules.ts'
import { PHOTO_QUALITY, PHOTO_QUALITY_SMALLER, THUMB_QUALITY, decodeImage, encodeScaled } from './image.ts'
import type { WorkerReply, WorkerRequest } from './types.ts'

// The compression worker: one job per worker, then the page terminates it (that is also how Cancel
// works — terminating stops the encoder at once). Mediabunny is imported only on the video path, so a
// photo never loads it.

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (message: WorkerReply) => scope.postMessage(message)

async function photo(file: File) {
  if (typeof OffscreenCanvas === 'undefined') {
    post({ type: 'error', code: 'unsupported', message: 'no OffscreenCanvas' })
    return
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await decodeImage(file)
  } catch {
    post({ type: 'error', code: 'unreadable', message: 'This picture format cannot be read by this browser. Save it as JPEG or PNG, or pick it again from the photo library.' })
    return
  }
  try {
    post({ type: 'progress', fraction: 0.3 })
    let image = await encodeScaled(bitmap, bitmap.width, bitmap.height, PHOTO_MAX_SIDE, PHOTO_QUALITY)
    if (image.blob.size > MAX_BYTES.photo) image = await encodeScaled(bitmap, bitmap.width, bitmap.height, PHOTO_MAX_SIDE, PHOTO_QUALITY_SMALLER)
    post({ type: 'progress', fraction: 0.8 })
    const thumb = await encodeScaled(bitmap, bitmap.width, bitmap.height, THUMB_MAX_SIDE, THUMB_QUALITY)
    post({ type: 'photo', image, thumb })
  } finally {
    bitmap.close()
  }
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    if (request.op === 'photo') {
      await photo(request.file)
    } else if (request.op === 'video-probe') {
      const { probeVideo } = await import('./video.ts')
      post({ type: 'probe', probe: await probeVideo(request.file) })
    } else {
      const { compressVideo, VideoUnsupportedError } = await import('./video.ts')
      try {
        const result = await compressVideo(request.file, (fraction) => post({ type: 'progress', fraction }))
        post({ type: 'video', ...result, poster: null })
      } catch (e) {
        if (e instanceof VideoUnsupportedError) post({ type: 'error', code: 'unsupported', message: e.message })
        else throw e
      }
    }
  } catch (e) {
    post({ type: 'error', code: 'failed', message: e instanceof Error ? e.message : String(e) })
  }
}
