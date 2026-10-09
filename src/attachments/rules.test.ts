import { describe, expect, it } from 'vitest'
import { attachmentsEnabled } from './flag.ts'
import {
  MAX_BYTES,
  classifyFile,
  displayName,
  fitWithin,
  formatBytes,
  formatDuration,
  planVideo,
  storableVideoType,
  urlIsFresh,
  videoFrameRate,
  videoTargetSize,
} from './rules.ts'

describe('feature flag (ATT-15)', () => {
  it('is on only for the exact string "true"', () => {
    expect(attachmentsEnabled({ VITE_ATTACHMENTS_ENABLED: 'true' })).toBe(true)
    expect(attachmentsEnabled({})).toBe(false)
    expect(attachmentsEnabled({ VITE_ATTACHMENTS_ENABLED: '1' })).toBe(false)
    expect(attachmentsEnabled({ VITE_ATTACHMENTS_ENABLED: 'TRUE' })).toBe(false)
  })
})

describe('classifyFile', () => {
  it.each([
    [{ name: 'a.jpg', type: 'image/jpeg' }, 'photo'],
    [{ name: 'IMG_1.HEIC', type: 'image/heic' }, 'photo'],
    [{ name: 'IMG_1.HEIC', type: '' }, 'photo'],
    [{ name: 'clip.MOV', type: 'video/quicktime' }, 'video'],
    [{ name: 'clip.mov', type: '' }, 'video'],
    [{ name: 'clip.mp4', type: 'application/octet-stream' }, 'video'],
    [{ name: 'rules.pdf', type: 'application/pdf' }, 'document'],
    [{ name: 'rules.PDF', type: '' }, 'document'],
    [{ name: 'notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, null],
    [{ name: 'archive.zip', type: '' }, null],
  ] as const)('%o → %s', (file, kind) => {
    expect(classifyFile(file)).toBe(kind)
  })
})

describe('storableVideoType', () => {
  it('keeps types the database stores and maps extensions when the type is missing', () => {
    expect(storableVideoType({ name: 'a.mov', type: 'video/quicktime' })).toBe('video/quicktime')
    expect(storableVideoType({ name: 'a.MOV', type: '' })).toBe('video/quicktime')
    expect(storableVideoType({ name: 'a.m4v', type: '' })).toBe('video/mp4')
    expect(storableVideoType({ name: 'a.3gp', type: 'video/3gpp' })).toBeNull()
    expect(storableVideoType({ name: 'a.mkv', type: 'video/x-matroska' })).toBeNull()
  })
})

describe('scaling', () => {
  it('never upscales and keeps even dimensions', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(3024, 4032, 400)).toEqual({ width: 300, height: 400 })
    expect(fitWithin(101, 51, 2048)).toEqual({ width: 102, height: 52 })
    expect(fitWithin(0, 10, 100)).toEqual({ width: 2, height: 2 })
  })
  it('targets 720p in either orientation', () => {
    expect(videoTargetSize(1920, 1080)).toEqual({ width: 1280, height: 720 })
    expect(videoTargetSize(1080, 1920)).toEqual({ width: 720, height: 1280 })
    expect(videoTargetSize(3840, 2160)).toEqual({ width: 1280, height: 720 })
    // A square or 4:3 clip is limited by its short side.
    expect(videoTargetSize(1440, 1440)).toEqual({ width: 720, height: 720 })
    expect(videoTargetSize(1440, 1080)).toEqual({ width: 960, height: 720 })
    expect(videoTargetSize(640, 360)).toEqual({ width: 640, height: 360 })
  })
  it('caps the frame rate at 30 only when the source is faster', () => {
    expect(videoFrameRate(59.94)).toBe(30)
    expect(videoFrameRate(30)).toBeUndefined()
    expect(videoFrameRate(29.97)).toBeUndefined()
    expect(videoFrameRate(null)).toBeUndefined()
  })
})

describe('planVideo (ARCHITECTURE.md §5, OQ-3 default)', () => {
  const base = { canCompress: true, durationMs: 60_000, sizeBytes: 200_000_000, storableType: 'video/quicktime' }
  it('compresses a clip of up to 3 minutes (+1 s slack)', () => {
    expect(planVideo(base)).toEqual({ action: 'compress' })
    expect(planVideo({ ...base, durationMs: 181_000 })).toEqual({ action: 'compress' })
    expect(planVideo({ ...base, durationMs: null })).toEqual({ action: 'compress' })
  })
  it('refuses a longer clip with a trim message', () => {
    const plan = planVideo({ ...base, durationMs: 181_001 })
    expect(plan).toMatchObject({ action: 'refuse' })
    expect(plan.action === 'refuse' && plan.message).toContain('Trim it to 3 minutes')
  })
  it('stores the original download-only when it cannot compress and the file fits', () => {
    expect(planVideo({ ...base, canCompress: false, sizeBytes: MAX_BYTES.video })).toEqual({ action: 'store-original', mimeType: 'video/quicktime' })
  })
  it('refuses when it cannot compress and the original is too large or of a type that cannot be stored', () => {
    expect(planVideo({ ...base, canCompress: false, sizeBytes: MAX_BYTES.video + 1 })).toMatchObject({ action: 'refuse' })
    expect(planVideo({ ...base, canCompress: false, sizeBytes: 1000, storableType: null })).toMatchObject({ action: 'refuse' })
  })
  it('a long clip that cannot be compressed is still stored if small (download-only has no length limit)', () => {
    expect(planVideo({ ...base, canCompress: false, durationMs: 600_000, sizeBytes: 50_000_000 })).toMatchObject({ action: 'store-original' })
  })
})

describe('displayName', () => {
  it('replaces the extension of a converted file and keeps the database name rule', () => {
    expect(displayName('IMG_0042.MOV', 'mp4')).toBe('IMG_0042.mp4')
    expect(displayName('photo', 'webp')).toBe('photo.webp')
    expect(displayName('  a\u0007b.pdf  ')).toBe('ab.pdf')
    expect(displayName('\u0001')).toBe('file')
    const long = displayName(`${'x'.repeat(300)}.jpg`)
    expect(long).toHaveLength(255)
    expect(long.endsWith('.jpg')).toBe(true)
  })
})

describe('formatting', () => {
  it('formats sizes in decimal units (as the quotas are)', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(34_500)).toBe('35 kB')
    expect(formatBytes(3_400_000)).toBe('3.4 MB')
    expect(formatBytes(34_000_000)).toBe('34 MB')
    expect(formatBytes(7_000_000_000)).toBe('7.00 GB')
  })
  it('formats durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_400)).toBe('1:05')
    expect(formatDuration(180_000)).toBe('3:00')
  })
})

describe('urlIsFresh', () => {
  it('treats a link as stale 5 minutes before it expires', () => {
    const t0 = 1_000_000
    expect(urlIsFresh(t0, 3600, t0 + 54 * 60_000)).toBe(true)
    expect(urlIsFresh(t0, 3600, t0 + 55 * 60_000)).toBe(false)
  })
})
