import type { LibraryFile } from '../data/useAttachments.ts'

// What the Files page shows: every ready file of the season, narrowed by kind and by a search words. Pure, so
// the rules are unit-tested; the page only draws what this returns.

export type KindFilter = 'all' | 'photo' | 'document' | 'video'

export const KIND_FILTERS: readonly { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'photo', label: 'Photos' },
  { id: 'document', label: 'PDFs' },
  { id: 'video', label: 'Videos' },
]

export function parseKind(value: string | null): KindFilter {
  return value === 'photo' || value === 'document' || value === 'video' ? value : 'all'
}

export function countByKind(files: readonly LibraryFile[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: files.length, photo: 0, document: 0, video: 0 }
  for (const f of files) counts[f.kind as Exclude<KindFilter, 'all'>] += 1
  return counts
}

// Every word typed must appear in the file name, the caption or the task title (any case).
export function filterFiles(files: readonly LibraryFile[], kind: KindFilter, query: string): LibraryFile[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return files.filter((f) => {
    if (kind !== 'all' && f.kind !== kind) return false
    if (words.length === 0) return true
    const hay = `${f.original_name} ${f.caption ?? ''} ${f.task_title}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
