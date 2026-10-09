import { fitWithin } from '../rules.ts'
import type { EncodedImage, ThumbType } from './types.ts'

// Image encoding shared by the worker (OffscreenCanvas) and the page (HTMLCanvasElement fallback for
// browsers without OffscreenCanvas). Re-encoding is also what strips a photo's EXIF data, GPS included.

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
type Source = ImageBitmap | OffscreenCanvas | HTMLCanvasElement | HTMLVideoElement | HTMLImageElement

export function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function toBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be encoded.'))), type, quality),
  )
}

// WebP where the browser can encode it. Safari silently returns a PNG for an unsupported type, so the
// result's type is checked, and JPEG (on white, it has no transparency) is used instead.
export async function encodeCanvas(canvas: AnyCanvas, quality: { webp: number; jpeg: number }): Promise<{ blob: Blob; type: ThumbType }> {
  const webp = await toBlob(canvas, 'image/webp', quality.webp)
  if (webp.type === 'image/webp') return { blob: webp, type: 'image/webp' }
  const flat = makeCanvas(canvas.width, canvas.height)
  const ctx = flat.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('The picture could not be encoded.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, flat.width, flat.height)
  ctx.drawImage(canvas, 0, 0)
  const jpeg = await toBlob(flat, 'image/jpeg', quality.jpeg)
  return { blob: jpeg, type: 'image/jpeg' }
}

export async function encodeScaled(
  source: Source,
  sourceWidth: number,
  sourceHeight: number,
  maxSide: number,
  quality: { webp: number; jpeg: number },
): Promise<EncodedImage> {
  const size = fitWithin(sourceWidth, sourceHeight, maxSide)
  const canvas = makeCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('The picture could not be encoded.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, size.width, size.height)
  const encoded = await encodeCanvas(canvas, quality)
  return { ...encoded, ...size }
}

export const PHOTO_QUALITY = { webp: 0.82, jpeg: 0.85 }
export const PHOTO_QUALITY_SMALLER = { webp: 0.65, jpeg: 0.7 }
export const THUMB_QUALITY = { webp: 0.72, jpeg: 0.75 }

// Decodes a picked picture upright. `imageOrientation: 'from-image'` applies the EXIF rotation; older
// engines reject the option object, so it is retried without.
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (e) {
    if (e instanceof TypeError) return createImageBitmap(file)
    throw e
  }
}
