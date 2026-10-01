import type { Task } from './types.ts'

// The one progress rule (execution contract, ADR-0006): count DISTINCT linked
// tasks, exclude cancelled tasks, include archived Done tasks, and report
// "no linked work" (percent: null) when the denominator is zero. An archived
// task that never finished is not completed: it stays in the denominator and
// is reported separately so the screen can say so. Requirement compliance is
// a different thing entirely (clause_status) and is never derived from this.
//
// Feed it the PROGRESS list (data/useTaskHistory.ts useTasksForProgress: active
// tasks plus archived ones), not the active Board list, or an archived Done task
// would silently drop out. The Gantt's milestone bars use it; the Register and
// Now adopt it in Phases 7/8.
//
// This file is the TypeScript mirror of the SQL view v_task_progress (20260129000100), the authoritative
// definition (PERMISSIONS §6.1). supabase/tests/progress_views_test.sql and tasks/progress.test.ts pin the
// same fixture to the same figures, so the two cannot drift apart silently:
//   total                distinct tasks, excluding cancelled, including archived
//   done                 distinct tasks in state done (archived or not)
//   archivedDone         of those, archived — they keep their contribution
//   archivedUnfinished   archived, neither done nor cancelled: in `total`, never `done`, reported apart
//   cancelled            left out of `total`, kept for history
//   openActive           not archived, not done, not cancelled: the active workload
//   percent              round(100 * done / total); null when total is 0 ("no linked work", never 0 %)
// A parent (department roll-up, section with subsections, milestone) is computed from its UNIQUE descendant
// tasks — never by averaging its children's percentages.
export type Progress = {
  done: number
  total: number
  percent: number | null
  archivedUnfinished: number
  archivedDone: number
  cancelled: number
  openActive: number
}

type ProgressTask = Pick<Task, 'state'> & Partial<Pick<Task, 'id' | 'archived_at'>>

export function taskProgress(tasks: readonly ProgressTask[]): Progress {
  const seen = new Set<string>()
  const distinct: ProgressTask[] = []
  for (const task of tasks) {
    if (task.id !== undefined) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
    }
    distinct.push(task)
  }
  const counted = distinct.filter((t) => t.state !== 'cancelled')
  const archived = (t: ProgressTask) => t.archived_at != null
  const done = counted.filter((t) => t.state === 'done').length
  return {
    done,
    total: counted.length,
    percent: counted.length === 0 ? null : Math.round((done / counted.length) * 100),
    archivedUnfinished: counted.filter((t) => t.state !== 'done' && archived(t)).length,
    archivedDone: counted.filter((t) => t.state === 'done' && archived(t)).length,
    cancelled: distinct.length - counted.length,
    openActive: counted.filter((t) => t.state !== 'done' && !archived(t)).length,
  }
}

// A department together with its subdepartments (PERMISSIONS §6.1 "department roll-up"): every task whose
// department is the parent or one of its children, each once.
export function departmentRollup<T extends ProgressTask & Pick<Task, 'subteam_key'>>(
  tasks: readonly T[],
  departments: readonly { key: string; parent_key: string | null }[],
  key: string,
): Progress {
  const keys = new Set([key, ...departments.filter((d) => d.parent_key === key).map((d) => d.key)])
  return taskProgress(tasks.filter((t) => t.subteam_key !== null && keys.has(t.subteam_key)))
}

// A section together with its subsections.
export function sectionRollup<T extends ProgressTask & Pick<Task, 'section_id'>>(
  tasks: readonly T[],
  sections: readonly { id: string; parent_section_id: string | null }[],
  sectionId: string,
): Progress {
  const ids = new Set([sectionId, ...sections.filter((s) => s.parent_section_id === sectionId).map((s) => s.id)])
  return taskProgress(tasks.filter((t) => t.section_id !== null && ids.has(t.section_id)))
}

// Every task that belongs to a milestone: those carrying its key directly
// (including unsectioned ones) and those in one of its sections, each once.
// A sectioned task usually satisfies both tests, so it is de-duplicated by id.
export function tasksInMilestone<T extends Pick<Task, 'id' | 'section_id' | 'milestone_key'>>(
  tasks: readonly T[],
  milestoneKey: string,
  sectionIds: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const task of tasks) {
    const inMilestone =
      task.milestone_key === milestoneKey || (task.section_id !== null && sectionIds.has(task.section_id))
    if (!inMilestone || seen.has(task.id)) continue
    seen.add(task.id)
    out.push(task)
  }
  return out
}
