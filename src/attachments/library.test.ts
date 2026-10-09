import { describe, expect, it } from 'vitest'
import type { LibraryFile } from '../data/useAttachments.ts'
import { countByKind, filterFiles, parseKind } from './library.ts'

const file = (id: string, kind: LibraryFile['kind'], original_name: string, task_title: string, caption: string | null = null): LibraryFile => ({
  id, task_id: `t-${id}`, kind, original_name, mime_type: 'x', size_bytes: 1, width: null, height: null, duration_ms: null,
  playable: true, caption, uploaded_by: null, created_at: '2026-10-09T00:00:00Z', task_title,
})

const FILES = [
  file('1', 'photo', 'logo.webp', 'Make Club logo'),
  file('2', 'photo', 'poster-with-qr.webp', 'Make SDU recruitment poster', 'Final version'),
  file('3', 'document', 'bylaws-v3.pdf', 'Discuss and agree Bylaws'),
  file('4', 'video', 'tour.mp4', 'Make SDU recruitment poster'),
]

describe('parseKind', () => {
  it('accepts the three kinds and falls back to all', () => {
    expect(parseKind('photo')).toBe('photo')
    expect(parseKind('document')).toBe('document')
    expect(parseKind('video')).toBe('video')
    expect(parseKind('nonsense')).toBe('all')
    expect(parseKind(null)).toBe('all')
  })
})

describe('countByKind', () => {
  it('counts each kind and the total', () => {
    expect(countByKind(FILES)).toEqual({ all: 4, photo: 2, document: 1, video: 1 })
    expect(countByKind([])).toEqual({ all: 0, photo: 0, document: 0, video: 0 })
  })
})

describe('filterFiles', () => {
  it('returns everything for All with no words', () => {
    expect(filterFiles(FILES, 'all', '')).toHaveLength(4)
    expect(filterFiles(FILES, 'all', '   ')).toHaveLength(4)
  })
  it('narrows by kind', () => {
    expect(filterFiles(FILES, 'photo', '').map((f) => f.id)).toEqual(['1', '2'])
    expect(filterFiles(FILES, 'document', '').map((f) => f.id)).toEqual(['3'])
  })
  it('matches file name, caption and task title, in any case', () => {
    expect(filterFiles(FILES, 'all', 'LOGO').map((f) => f.id)).toEqual(['1'])
    expect(filterFiles(FILES, 'all', 'final').map((f) => f.id)).toEqual(['2'])
    expect(filterFiles(FILES, 'all', 'bylaws').map((f) => f.id)).toEqual(['3'])
  })
  it('needs every word to match', () => {
    expect(filterFiles(FILES, 'all', 'poster qr').map((f) => f.id)).toEqual(['2'])
    expect(filterFiles(FILES, 'all', 'poster banana')).toEqual([])
  })
  it('combines kind and words', () => {
    expect(filterFiles(FILES, 'video', 'poster').map((f) => f.id)).toEqual(['4'])
    expect(filterFiles(FILES, 'photo', 'tour')).toEqual([])
  })
})
