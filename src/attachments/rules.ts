// The attachment rules the browser needs before it talks to anyone (Ultraplan Phase 3): which kind a
// picked file is, how big the compressed result may be, how a video is scaled, and what happens to a
// video this browser cannot compress. Pure — no DOM, no network — so every decision is unit-tested.
//
// The database is the authority on every limit (request_attachment_upload(), migration
// 20260132000000_task_attachments.sql). These copies exist only to refuse early, with a better message,
// before minutes are spent compressing a file the database would refuse anyway.

export type AttachmentKind = 'photo' | 'document' | 'video'

const MIB = 1024 * 1024

// attachment_size_limit(kind): the largest STORED file (after compression).
export const MAX_BYTES: Record<AttachmentKind, number> = {
  photo: 10 * MIB,
  document: 10 * MIB,
  video: 100 * MIB,
}

// A playable video is at most 3 minutes; the database allows 185 s for encoder rounding.
export const MAX_VIDEO_MS = 180_000
const VIDEO_DURATION_SLACK_MS = 1_000

// Photos: longest side 2048 px; thumbnails and video posters: longest side 400 px.
export const PHOTO_MAX_SIDE = 2048
export const THUMB_MAX_SIDE = 400

// Videos: 720p in either orientation (1280×720 or 720×1280), H.264 ~1.5 Mbit/s, AAC 128 kbit/s, ≤ 30 fps.
export const VIDEO_LONG_SIDE = 1280
export const VIDEO_SHORT_SIDE = 720
export const VIDEO_BITRATE = 1_500_000
export const AUDIO_BITRATE = 128_000
export const VIDEO_MAX_FPS = 30

// A photo larger than this is not even decoded: a 200 MB "photo" is a mistake, and decoding it can take
// down a phone's tab.
export const MAX_PHOTO_INPUT_BYTES = 60 * MIB

// What the database stores per kind (attachment_mime_extension()).
export const STORED_TYPES: Record<AttachmentKind, readonly string[]> = {
  photo: ['image/webp', 'image/jpeg', 'image/png'],
  document: ['application/pdf'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
}

// What the file picker offers. Images and videos in any format the browser can decode; documents are PDF.
export const PICKER_ACCEPT = 'image/*,video/*,application/pdf,.pdf,.heic,.heif,.mov,.mp4,.webm,.m4v'

const VIDEO_EXT: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }
const PHOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif', 'bmp'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

// Some Android pickers hand over files with an empty type, and an iPhone .mov may arrive as
// "video/quicktime" or not at all, so the extension is the fallback.
export function classifyFile(file: { name: string; type: string }): AttachmentKind | null {
  const type = file.type.toLowerCase()
  const ext = extensionOf(file.name)
  if (type === 'application/pdf' || (type === '' && ext === 'pdf')) return 'document'
  if (type.startsWith('image/')) return 'photo'
  if (type.startsWith('video/')) return 'video'
  if (type === '' || type === 'application/octet-stream') {
    if (PHOTO_EXT.has(ext)) return 'photo'
    if (ext in VIDEO_EXT) return 'video'
  }
  return null
}

// The type an original video is stored under when it cannot be compressed, or null when the database
// would not take it (e.g. a .3gp or .mkv).
export function storableVideoType(file: { name: string; type: string }): string | null {
  const type = file.type.toLowerCase()
  if (STORED_TYPES.video.includes(type)) return type
  if (type === '' || type === 'application/octet-stream') return VIDEO_EXT[extensionOf(file.name)] ?? null
  return null
}

// Scales (w, h) down — never up — so the longest side is at most `maxLong` and the shortest at most
// `maxShort`; both results are even (H.264 needs even dimensions; harmless for images).
export function fitWithin(width: number, height: number, maxLong: number, maxShort = maxLong): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 2, height: 2 }
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const scale = Math.min(1, maxLong / long, maxShort / short)
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { width: even(width), height: even(height) }
}

export function videoTargetSize(width: number, height: number) {
  return fitWithin(width, height, VIDEO_LONG_SIDE, VIDEO_SHORT_SIDE)
}

export function videoFrameRate(sourceFps: number | null): number | undefined {
  return sourceFps !== null && sourceFps > VIDEO_MAX_FPS + 1 ? VIDEO_MAX_FPS : undefined
}

// What happens to a picked video (ARCHITECTURE.md §5, open question OQ-3's default).
export type VideoPlan =
  | { action: 'compress' }
  | { action: 'store-original'; mimeType: string }
  | { action: 'refuse'; message: string }

export function planVideo(input: {
  canCompress: boolean
  durationMs: number | null
  sizeBytes: number
  storableType: string | null
}): VideoPlan {
  if (input.canCompress) {
    if (input.durationMs !== null && input.durationMs > MAX_VIDEO_MS + VIDEO_DURATION_SLACK_MS) {
      return { action: 'refuse', message: `This video is ${formatDuration(input.durationMs)} long. Trim it to 3 minutes or less, then add it again.` }
    }
    return { action: 'compress' }
  }
  if (input.storableType === null) {
    return { action: 'refuse', message: 'This browser cannot compress this video, and its format cannot be stored as it is. Try from another browser or phone, or convert it to MP4.' }
  }
  if (input.sizeBytes > MAX_BYTES.video) {
    return {
      action: 'refuse',
      message: `This browser cannot compress video, and the original (${formatBytes(input.sizeBytes)}) is over the ${formatBytes(MAX_BYTES.video)} limit for uncompressed files. Trim the clip, or add it from a phone or an up-to-date Chrome, Edge or Safari.`,
    }
  }
  return { action: 'store-original', mimeType: input.storableType }
}

// The name shown and used when saving. The compressed result gets the extension of what it now is
// (IMG_0042.MOV → IMG_0042.mp4). Matches the database's name rule: trimmed, 1..255, no control characters.
export function displayName(original: string, newExtension?: string): string {
  // eslint-disable-next-line no-control-regex
  let name = original.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (name === '') name = 'file'
  if (newExtension) {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    name = `${stem}.${newExtension}`
  }
  if (name.length > 255) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : ''
    name = name.slice(0, 255 - ext.length).trimEnd() + ext
  }
  return name
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// A signed URL is treated as expired a little before it really is, so a request started just before
// the deadline does not fail halfway.
export const URL_EXPIRY_MARGIN_MS = 5 * 60 * 1000

export function urlIsFresh(fetchedAt: number, expiresInSeconds: number, now: number): boolean {
  return now < fetchedAt + expiresInSeconds * 1000 - URL_EXPIRY_MARGIN_MS
}
