import type { ClauseState } from '../../clauses/types.ts'
import { taskProgress, type Progress } from '../../tasks/progress.ts'
import type { Task } from '../../tasks/types.ts'

// The work linked to each requirement, computed once for the whole Register
// from two flat lists (every task↔requirement link of the season, and every
// task the season has, archived ones included) — never a query per clause.
//
// Identity is clause_key. printed_ref is NOT unique (E.5.4.5 and F.5.2.3 are
// each printed twice), so two rows that print the same reference keep separate
// task lists.
export type LinkedTask = Pick<
  Task,
  'id' | 'title' | 'state' | 'priority' | 'owner_id' | 'subteam_key' | 'archived_at'
>

export type LinkLike = { task_id: string; clause_key: string }

export type LinkedWork = {
  // Every linked task, cancelled and archived ones included, in display order.
  tasks: LinkedTask[]
  // The one shared rule: distinct tasks, cancelled excluded, archived Done
  // counted, archived-unfinished kept in the denominator.
  progress: Progress
  // Linked task ids the task list does not know (a lookup that has not
  // arrived, or one the viewer cannot read). Never counted as work.
  unknown: number
}

// Where a linked task opens: the same Board card and editor everyone else uses,
// or, once it is archived (it is no longer on the Board), its Archive entry.
export function taskHref(task: Pick<LinkedTask, 'id' | 'archived_at'>): string {
  return task.archived_at
    ? `/archive?tab=tasks&id=${encodeURIComponent(task.id)}`
    : `/board?task=${encodeURIComponent(task.id)}`
}

const EMPTY: LinkedWork = { tasks: [], progress: taskProgress([]), unknown: 0 }

// Unfinished live work first (what needs attention), then finished, then
// archived, then cancelled. Stable by title inside each group.
function rank(task: LinkedTask): number {
  if (task.state === 'cancelled') return 3
  if (task.archived_at) return 2
  if (task.state === 'done') return 1
  return 0
}

export function indexLinkedWork(
  links: readonly LinkLike[],
  tasks: readonly LinkedTask[],
): Map<string, LinkedWork> {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const perClause = new Map<string, { seen: Set<string>; tasks: LinkedTask[]; unknown: number }>()

  for (const link of links) {
    let entry = perClause.get(link.clause_key)
    if (!entry) {
      entry = { seen: new Set(), tasks: [], unknown: 0 }
      perClause.set(link.clause_key, entry)
    }
    // A duplicate link row cannot exist (primary key), but the count must not
    // depend on that.
    if (entry.seen.has(link.task_id)) continue
    entry.seen.add(link.task_id)
    const task = byId.get(link.task_id)
    if (task) entry.tasks.push(task)
    else entry.unknown += 1
  }

  const out = new Map<string, LinkedWork>()
  for (const [clauseKey, entry] of perClause) {
    const ordered = [...entry.tasks].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
    out.set(clauseKey, { tasks: ordered, progress: taskProgress(ordered), unknown: entry.unknown })
  }
  return out
}

export function linkedWorkFor(index: ReadonlyMap<string, LinkedWork>, clauseKey: string): LinkedWork {
  return index.get(clauseKey) ?? EMPTY
}

// "3 / 5 linked tasks done", or "No linked work" — never 0% or 100% for nothing.
export function progressHeadline(progress: Progress): string {
  if (progress.total === 0) return 'No linked work'
  return `${progress.done} / ${progress.total} linked ${progress.total === 1 ? 'task' : 'tasks'} done`
}

export function progressDetail(work: LinkedWork): string | null {
  const parts: string[] = []
  if (work.progress.archivedUnfinished > 0) {
    parts.push(`${work.progress.archivedUnfinished} archived before finishing, still counted as not done`)
  }
  const cancelled = work.tasks.filter((t) => t.state === 'cancelled').length
  if (cancelled > 0) parts.push(`${cancelled} cancelled, not counted`)
  if (work.unknown > 0) parts.push(`${work.unknown} linked task${work.unknown === 1 ? '' : 's'} could not be loaded`)
  return parts.length > 0 ? parts.join(' · ') : null
}

const SETTLED: ReadonlySet<ClauseState> = new Set<ClauseState>(['compliant', 'verified', 'na'])

// When every counted linked task is done, the Register OFFERS a "Mark
// compliant" shortcut. It is only ever an offer: finished tasks do not make a
// requirement compliant, and never verified — that stays a person's decision
// on clause_status. No offer once the requirement is already settled, and none
// while an archived task never finished.
export function offersMarkCompliant(state: ClauseState, work: LinkedWork): boolean {
  if (SETTLED.has(state)) return false
  const { progress } = work
  return progress.total > 0 && progress.done === progress.total && progress.archivedUnfinished === 0
}
