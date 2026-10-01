import type { Task } from './types.ts'

// Prerequisite links between tasks ("this task waits for that one"), as the
// screens need them. Pure: the database owns the rules (same season, no
// self-link, no circle, who may change a link — 20260128000000); this module
// only lets a screen show what exists, offer sensible candidates, and flag a
// schedule that contradicts a link. It never decides whether a write is allowed.

export type TaskLink = { task_id: string; depends_on_task_id: string }

export type TaskRef = Pick<Task, 'id' | 'title' | 'state' | 'due_date' | 'starts_on' | 'subteam_key' | 'archived_at'>

// The lists on the Board and Gantt hold ACTIVE tasks only, so the other end of a
// link can be a task that has since been archived. It is shown as exactly that —
// an archived task, finished as far as this link is concerned — never dropped,
// so a link never silently disappears from the screen.
// A truthy stand-in for "archived at some time we do not have": the active lists
// do not carry archived rows, and a link only needs to know it is finished.
export const ARCHIVED_UNKNOWN = 'archived'
function archivedPlaceholder(id: string): TaskRef {
  return { id, title: 'An archived task', state: 'done', due_date: null, starts_on: null, subteam_key: null, archived_at: ARCHIVED_UNKNOWN }
}

// A lookup that knows archived tasks too (by id, with the title they had), so a prerequisite that finished and
// was archived still reads by name. Active rows win; an archived row has no dates (it is finished).
export function taskRefLookup(
  active: readonly TaskRef[],
  archived: readonly Pick<TaskRef, 'id' | 'title' | 'state' | 'subteam_key' | 'archived_at'>[],
): Map<string, TaskRef> {
  const out = new Map<string, TaskRef>()
  for (const t of archived) out.set(t.id, { ...t, due_date: null, starts_on: null })
  for (const t of active) out.set(t.id, t)
  return out
}

// What a task waits for, in a stable order (by the prerequisite's title).
export function prerequisitesOf(links: readonly TaskLink[], taskId: string, byId: ReadonlyMap<string, TaskRef>): TaskRef[] {
  return links
    .filter((l) => l.task_id === taskId)
    .map((l) => byId.get(l.depends_on_task_id) ?? archivedPlaceholder(l.depends_on_task_id))
    .sort((a, b) => a.title.localeCompare(b.title))
}

// What waits for this task.
export function dependentsOf(links: readonly TaskLink[], taskId: string, byId: ReadonlyMap<string, TaskRef>): TaskRef[] {
  return links
    .filter((l) => l.depends_on_task_id === taskId)
    .map((l) => byId.get(l.task_id) ?? archivedPlaceholder(l.task_id))
    .sort((a, b) => a.title.localeCompare(b.title))
}

// Every task that, directly or through others, already waits for `taskId` — a
// new prerequisite for `taskId` must not be one of them or the link would close
// a circle. Offered to the picker so it never lists a choice the database will
// refuse; the database still checks, under a lock, for the case two people
// choose at the same moment.
export function waitersOf(links: readonly TaskLink[], taskId: string): Set<string> {
  // depends_on -> the tasks waiting for it, built once so the walk is linear.
  const waitingFor = new Map<string, string[]>()
  for (const l of links) waitingFor.set(l.depends_on_task_id, [...(waitingFor.get(l.depends_on_task_id) ?? []), l.task_id])
  const waiting = new Set<string>()
  const queue = [taskId]
  while (queue.length > 0) {
    for (const next of waitingFor.get(queue.pop() as string) ?? []) {
      if (!waiting.has(next)) {
        waiting.add(next)
        queue.push(next)
      }
    }
  }
  return waiting
}

// Tasks that can be offered as a NEW prerequisite of `task`: same season (the
// list is already that season's), not itself, not archived, not already linked,
// and not something that already waits for it.
export function prerequisiteCandidates(
  task: Pick<Task, 'id'>,
  tasks: readonly TaskRef[],
  links: readonly TaskLink[],
): TaskRef[] {
  const linked = new Set(links.filter((l) => l.task_id === task.id).map((l) => l.depends_on_task_id))
  const waiters = waitersOf(links, task.id)
  return tasks
    .filter((t) => t.id !== task.id && t.archived_at === null && !linked.has(t.id) && !waiters.has(t.id))
    .sort((a, b) => a.title.localeCompare(b.title))
}

// A prerequisite that is finished stops holding anything up.
export function isSatisfied(prerequisite: Pick<Task, 'state' | 'archived_at'>): boolean {
  return prerequisite.state === 'done' || prerequisite.state === 'cancelled' || prerequisite.archived_at !== null
}

export function openPrerequisites(prerequisites: readonly TaskRef[]): TaskRef[] {
  return prerequisites.filter((p) => !isSatisfied(p))
}

// Advisory only — nothing is rescheduled: the task starts (or is due) before an
// unfinished prerequisite is due. Compared as calendar dates (YYYY-MM-DD strings
// sort correctly), never through a timezone.
export function scheduleConflict(
  task: Pick<Task, 'starts_on' | 'due_date'>,
  prerequisite: Pick<Task, 'due_date' | 'state' | 'archived_at'>,
): boolean {
  if (isSatisfied(prerequisite) || prerequisite.due_date === null) return false
  const begins = task.starts_on ?? task.due_date
  return begins !== null && begins < prerequisite.due_date
}
