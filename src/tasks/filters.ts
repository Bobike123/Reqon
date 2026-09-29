import { ALL_DEPARTMENTS, resolveDepartmentParam } from '../departments/filter.ts'
import { mergeSearchParams } from '../lib/searchParams.ts'
import { tasksInScope, type TaskScope } from './scope.ts'
import type { Task } from './types.ts'

// The Board's two independent filters: Scope (All tasks / My tasks) and
// Department. There is no tab per combination; any Scope goes with any
// Department. "My tasks" is owner_id = the viewer, nothing else.
export type TaskFilter = { scope: TaskScope; department: string }
export const DEFAULT_TASK_FILTER: TaskFilter = { scope: 'all', department: ALL_DEPARTMENTS }

// Generic over the row shape, so the same filter serves the Board's full tasks
// and the progress list's slimmer rows (the Gantt's department lens).
export function filterTasks<T extends Pick<Task, 'owner_id' | 'subteam_key'>>(
  tasks: readonly T[],
  filter: TaskFilter,
  myId: string | null,
): T[] {
  return tasksInScope(tasks, filter.scope, myId).filter(
    (t) => filter.department === ALL_DEPARTMENTS || t.subteam_key === filter.department,
  ) as T[]
}

// What each Scope button would show under the chosen department.
export function taskScopeCounts(tasks: readonly Task[], department: string, myId: string | null): Record<TaskScope, number> {
  return {
    all: filterTasks(tasks, { scope: 'all', department }, myId).length,
    mine: filterTasks(tasks, { scope: 'mine', department }, myId).length,
  }
}

type Dept = { key: string; name: string; archived_at: string | null }

// Read the filter from an address. Unknown values never silently pick another
// view: a bad scope or department falls back to the default WITH a notice. Only
// this season's tasks are ever loaded, so a stale filter cannot show another
// season's work — at worst it shows an empty list and says why.
export function taskFilterFromParams(
  params: URLSearchParams,
  departments: readonly Dept[],
): { filter: TaskFilter; notice: string | null } {
  const rawScope = params.get('scope')
  const scope: TaskScope = rawScope === 'mine' ? 'mine' : 'all'
  const scopeNotice = rawScope && rawScope !== 'mine' && rawScope !== 'all' ? `“${rawScope}” is not a view of the Board, so all tasks are shown.` : null
  const { department, notice } = resolveDepartmentParam(params.get('dept'), departments)
  return { filter: { scope, department }, notice: scopeNotice ?? notice }
}

// Only non-default values are written, so the plain Board keeps a plain address.
export function taskFilterToParams(filter: TaskFilter): URLSearchParams {
  const params = new URLSearchParams()
  if (filter.scope === 'mine') params.set('scope', 'mine')
  if (filter.department !== ALL_DEPARTMENTS) params.set('dept', filter.department)
  return params
}

// The filter written INTO an existing address: scope and department change,
// every other parameter (?task=, the Gantt's open groups, …) is kept.
export function applyTaskFilter(current: URLSearchParams, filter: TaskFilter): URLSearchParams {
  return mergeSearchParams(current, {
    scope: filter.scope === 'mine' ? 'mine' : null,
    dept: filter.department !== ALL_DEPARTMENTS ? filter.department : null,
  })
}

export function isDefaultTaskFilter(filter: TaskFilter): boolean {
  return filter.scope === 'all' && filter.department === ALL_DEPARTMENTS
}
