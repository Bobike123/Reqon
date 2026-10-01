import type { Milestone } from './types.ts'

// The label people read and type for a milestone ("MS1-1"). It is `code`, which is unique PER SEASON, so a
// new season can reuse it. `key` is the opaque identifier every link uses (it may look like "MS1-1~1a2b3c4d"
// in a later season) and must never be shown as the name. A row without a code (an older cache) shows its key.
export function milestoneLabel(m: Pick<Milestone, 'key'> & Partial<Pick<Milestone, 'code'>>): string {
  return m.code ?? m.key
}
