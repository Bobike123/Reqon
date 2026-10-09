// What the compression step hands to the uploader, and the messages between the page and the worker.
// Kept free of Mediabunny imports so the page-side code can import it without pulling the library in.

export type ThumbType = 'image/webp' | 'image/jpeg'

export type PreparedFile = {
  kind: 'photo' | 'document' | 'video'
  blob: Blob
  mimeType: string
  name: string
  width: number | null
  height: number | null
  durationMs: number | null
  playable: boolean
  thumb: { blob: Blob; type: ThumbType } | null
  // Said to the person after the upload, e.g. why a video was stored download-only.
  note: string | null
}

export type EncodedImage = { blob: Blob; type: ThumbType; width: number; height: number }

export type WorkerRequest =
  | { op: 'photo'; file: File }
  | { op: 'video-probe'; file: File }
  | { op: 'video-compress'; file: File }

export type VideoProbe = {
  durationMs: number | null
  width: number | null
  height: number | null
  // Why this browser cannot compress the file (null = it can).
  unsupported: string | null
  poster: EncodedImage | null
}

export type WorkerReply =
  | { type: 'progress'; fraction: number }
  | { type: 'photo'; image: EncodedImage; thumb: EncodedImage }
  | { type: 'probe'; probe: VideoProbe }
  | { type: 'video'; blob: Blob; width: number; height: number; durationMs: number; poster: EncodedImage | null }
  | { type: 'error'; message: string; code: 'unsupported' | 'unreadable' | 'failed' }
