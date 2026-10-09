import {
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  WEBM,
  canEncodeAudio,
  canEncodeVideo,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny'
import { AUDIO_BITRATE, THUMB_MAX_SIDE, VIDEO_BITRATE, fitWithin, videoFrameRate, videoTargetSize } from '../rules.ts'
import { THUMB_QUALITY, encodeCanvas } from './image.ts'
import type { EncodedImage, VideoProbe } from './types.ts'

// Video compression with WebCodecs through Mediabunny (DECISIONS.md D-07, D-08), run inside the worker.
// 720p H.264 ~1.5 Mbit/s, AAC, fast-start MP4, ≤ 30 fps, rotation baked in, no metadata tags (D-28).
// Only the containers phones and desktops record are read, which keeps the worker chunk small.

const FORMATS = [MP4, QTFF, WEBM, MATROSKA]

function open(file: Blob): Input {
  return new Input({ source: new BlobSource(file), formats: FORMATS })
}

async function trackFps(track: InputVideoTrack): Promise<number | null> {
  try {
    const stats = await track.computePacketStats(60)
    return Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0 ? stats.averagePacketRate : null
  } catch {
    return null
  }
}

// AAC audio is copied as it is (no AudioEncoder needed: what iPhones and Android phones record); other
// audio must be transcoded, which needs an AAC encoder (DECISIONS.md D-27).
async function audioProblem(track: InputAudioTrack | null): Promise<string | null> {
  if (!track || track.codec === 'aac') return null
  const ok = await canEncodeAudio('aac', { bitrate: AUDIO_BITRATE, numberOfChannels: Math.min(2, track.numberOfChannels), sampleRate: 48000 }).catch(() => false)
  return ok ? null : 'this browser cannot convert the sound of this video to AAC'
}

async function posterOf(track: InputVideoTrack, durationS: number): Promise<EncodedImage | null> {
  try {
    if (!(await track.canDecode())) return null
    const size = fitWithin(track.displayWidth, track.displayHeight, THUMB_MAX_SIDE)
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: 'contain' })
    // About one second in: the very first frame is often black or a blur.
    const at = Math.min(1, Math.max(0, durationS / 3))
    const frame = (await sink.getCanvas(at)) ?? (await sink.getCanvas(0))
    if (!frame) return null
    return { ...(await encodeCanvas(frame.canvas, THUMB_QUALITY)), ...size }
  } catch {
    return null
  }
}

export async function probeVideo(file: Blob): Promise<VideoProbe> {
  const input = open(file)
  try {
    let durationS: number
    let track: InputVideoTrack | null
    try {
      track = await input.getPrimaryVideoTrack()
      durationS = await input.computeDuration()
    } catch {
      return { durationMs: null, width: null, height: null, unsupported: 'this browser cannot read this video file', poster: null }
    }
    if (!track) return { durationMs: null, width: null, height: null, unsupported: 'the file has no picture track', poster: null }
    const durationMs = Number.isFinite(durationS) && durationS > 0 ? Math.round(durationS * 1000) : null
    const width = track.displayWidth || null
    const height = track.displayHeight || null
    let unsupported: string | null = null
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
      unsupported = 'this browser has no video encoder (WebCodecs)'
    } else if (!(await track.canDecode().catch(() => false))) {
      unsupported = 'this browser cannot decode this video'
    } else {
      const target = videoTargetSize(track.displayWidth, track.displayHeight)
      const encodable = await canEncodeVideo('avc', { width: target.width, height: target.height, bitrate: VIDEO_BITRATE }).catch(() => false)
      if (!encodable) unsupported = 'this browser cannot encode H.264 video'
      else unsupported = await audioProblem(await input.getPrimaryAudioTrack().catch(() => null))
    }
    const poster = await posterOf(track, durationS)
    return { durationMs, width, height, unsupported, poster }
  } finally {
    input.dispose()
  }
}

export class VideoUnsupportedError extends Error {}

export async function compressVideo(
  file: Blob,
  onProgress: (fraction: number) => void,
): Promise<{ blob: Blob; width: number; height: number; durationMs: number }> {
  const input = open(file)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new VideoUnsupportedError('the file has no picture track')
    const audio = await input.getPrimaryAudioTrack().catch(() => null)
    const target = videoTargetSize(track.displayWidth, track.displayHeight)
    const target2 = new BufferTarget()
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: target2 })
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: {
        width: target.width,
        height: target.height,
        fit: 'contain',
        codec: 'avc',
        bitrate: VIDEO_BITRATE,
        frameRate: videoFrameRate(await trackFps(track)),
        keyFrameInterval: 2,
        allowTransformationMetadata: false,
        forceTranscode: true,
      },
      audio: audio?.codec === 'aac' ? { codec: 'aac' } : { codec: 'aac', bitrate: AUDIO_BITRATE },
      tags: {},
      showWarnings: false,
    })
    const lostAudio = conversion.discardedTracks.some((d) => d.track.type === 'audio' && d.reason !== 'discarded_by_user')
    const lostVideo = conversion.discardedTracks.some((d) => d.track.type === 'video' && d.reason !== 'discarded_by_user')
    if (!conversion.isValid || lostVideo) throw new VideoUnsupportedError('this browser cannot convert this video')
    if (lostAudio) throw new VideoUnsupportedError('this browser cannot convert the sound of this video')
    conversion.onProgress = (p) => onProgress(Math.max(0, Math.min(1, p)))
    await conversion.execute()
    const buffer = target2.buffer
    if (!buffer) throw new Error('The compressed video is empty.')
    const blob = new Blob([buffer], { type: 'video/mp4' })
    // Measured on the result, which is what the database stores and checks (≤ 185 s).
    const check = open(blob)
    try {
      const durationS = await check.computeDuration()
      return { blob, width: target.width, height: target.height, durationMs: Math.max(1, Math.round(durationS * 1000)) }
    } finally {
      check.dispose()
    }
  } finally {
    input.dispose()
  }
}
