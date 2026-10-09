import { THUMB_MAX_SIDE } from '../rules.ts'
import { THUMB_QUALITY, encodeCanvas, encodeScaled, makeCanvas } from './image.ts'
import type { EncodedImage } from './types.ts'

// A poster for a video the worker could not decode (it is stored download-only, DECISIONS.md D-30). The
// database needs one for every video. First try the browser's own <video> element — it can often play
// what WebCodecs cannot (e.g. HEVC in Safari's player) — then fall back to a drawn placeholder.

export async function posterFromVideoElement(file: Blob, timeoutMs = 8000): Promise<EncodedImage | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    const frame = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      video.onloadeddata = () => {
        video.currentTime = Math.min(1, (video.duration || 0) / 3)
      }
      video.onseeked = () => {
        clearTimeout(timer)
        resolve(video.videoWidth > 0)
      }
      video.onerror = () => {
        clearTimeout(timer)
        resolve(false)
      }
      video.src = url
    })
    if (!frame) return null
    return await encodeScaled(video, video.videoWidth, video.videoHeight, THUMB_MAX_SIDE, THUMB_QUALITY)
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

export async function placeholderPoster(): Promise<EncodedImage> {
  const width = 400
  const height = 225
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ctx.fillStyle = '#334155'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#e2e8f0'
  ctx.beginPath()
  ctx.moveTo(180, 82)
  ctx.lineTo(228, 112)
  ctx.lineTo(180, 142)
  ctx.closePath()
  ctx.fill()
  ctx.font = '16px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('Video — download to watch', width / 2, 180)
  return { ...(await encodeCanvas(canvas, THUMB_QUALITY)), width, height }
}
