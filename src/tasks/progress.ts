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
export type Progress = {
  done: number
  total: number
  percent: number | null
  archivedUnfinished: number
}

type ProgressTask = Pick<Task, 'state'> & Partial<Pick<Task, 'id' | 'archived_at'>>

export function taskProgress(tasks: readonly ProgressTask[]): Progress {
  const seen = new Set<string>()
  const counted: ProgressTask[] = []
  for (const task of tasks) {
    if (task.state === 'cancelled') continue
    if (task.id !== undefined) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
    }
    counted.push(task)
  }
  const done = counted.filter((t) => t.state === 'done').length
  const archivedUnfinished = counted.filter((t) => t.state !== 'done' && t.archived_at != null).length
  return {
    done,
    total: counted.length,
    percent: counted.length === 0 ? null : Math.round((done / counted.length) * 100),
    archivedUnfinished,
  }
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
