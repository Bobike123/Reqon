import type { Task } from '../../tasks/types.ts'

// Linking an EXISTING Board task into the timeline. This is the Gantt's only
// work-association command: it can never create a task, and it never copies one
// (a task has exactly one milestone and at most one section, so it appears once).
//
// What this file decides is only what the screen OFFERS. The database decides
// what is allowed, again, on every write: can_edit_task() (owner, that
// department's Head, or a Developer), the archived-row refusal, and the
// milestone/section consistency trigger (same season; a section's milestone and
// the task's milestone can never disagree). Offering less than the server would
// accept is fine; offering something it refuses would only produce an error.

export type LinkTarget = {
  seasonId: string
  milestoneKey: string
  // null = the milestone's own "unsectioned work" group (no real section yet).
  sectionId: string | null
}

type Linkable = Pick<
  Task,
  'id' | 'title' | 'season_id' | 'archived_at' | 'milestone_key' | 'section_id' | 'links_required'
>

export type LinkCandidates<T extends Linkable> = {
  // Can be linked here as it is: it has no milestone yet, or is already on this one.
  direct: T[]
  // Sits on a DIFFERENT milestone. Linking it here moves it: milestone and
  // section change together, in one write, and the person confirms first.
  relink: T[]
}

export function linkCandidates<T extends Linkable>(
  tasks: readonly T[],
  target: LinkTarget,
  canEdit: (task: T) => boolean,
): LinkCandidates<T> {
  const direct: T[] = []
  const relink: T[] = []
  for (const task of tasks) {
    if (task.archived_at !== null) continue // restore it first (Archive)
    if (task.season_id !== target.seasonId) continue // never across seasons
    if (!canEdit(task)) continue // readable, but not linkable by this person
    // Already exactly here: nothing to do.
    if (task.milestone_key === target.milestoneKey && task.section_id === target.sectionId) continue
    if (task.milestone_key === null || task.milestone_key === target.milestoneKey) direct.push(task)
    else relink.push(task)
  }
  const byTitle = (a: T, b: T) => a.title.localeCompare(b.title)
  return { direct: direct.sort(byTitle), relink: relink.sort(byTitle) }
}

// The write for a link. Milestone and section are always sent TOGETHER, so a
// relink is one atomic UPDATE that the consistency trigger either accepts whole
// or refuses whole — never a state where they contradict.
export function linkEdit(task: Pick<Task, 'id'>, target: LinkTarget): { id: string; sectionId: string | null; milestoneKey: string } {
  return { id: task.id, sectionId: target.sectionId, milestoneKey: target.milestoneKey }
}

// Unlinking a section leaves the milestone alone: the task simply becomes
// unsectioned work under it. (A promoted task must keep its milestone; this is
// the only unlink that always works.)
export function unlinkSectionEdit(task: Pick<Task, 'id'>): { id: string; sectionId: null } {
  return { id: task.id, sectionId: null }
}

// Unlinking from the milestone itself. Refused for promoted work (links_required),
// which must keep its milestone — so the screen does not offer it there.
export function canUnlinkMilestone(task: Pick<Task, 'links_required'>): boolean {
  return !task.links_required
}

export function unlinkMilestoneEdit(task: Pick<Task, 'id'>): { id: string; sectionId: null; milestoneKey: null } {
  return { id: task.id, sectionId: null, milestoneKey: null }
}

// Where a candidate would be moving FROM, in words, for the confirmation.
export function relinkFrom(task: Pick<Task, 'milestone_key' | 'section_id'>, sectionName: (id: string) => string | null): string {
  const milestone = task.milestone_key ?? 'no milestone'
  const section = task.section_id ? sectionName(task.section_id) : null
  return section ? `${milestone} · ${section}` : milestone
}

// One stable key per place a task can sit on the timeline (a section, or a
// submission's unsectioned group), for the "Move to" select and drop targets.
export function targetKey(target: Pick<LinkTarget, 'milestoneKey' | 'sectionId'>): string {
  return `${target.milestoneKey}::${target.sectionId ?? ''}`
}

// Where a task sits now, in the same key space — or '' when it is on no
// submission (a loose Board task, which the timeline does not list).
export function currentTargetKey(task: Pick<Task, 'milestone_key' | 'section_id'>): string {
  return task.milestone_key ? targetKey({ milestoneKey: task.milestone_key, sectionId: task.section_id }) : ''
}
