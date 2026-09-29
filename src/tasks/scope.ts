import type { Task } from './types.ts'

// The one All/My scope convention (ADR-0011, execution contract "share one
// ... All/My scope convention ... across consumers"), extracted from
// Board.tsx's own inline Scope type — a view filter only, never hiding a
// task from anyone: switching back to 'all' always shows the whole board
// again. Board is still the only consumer this phase; a department axis
// (Board §8.1) is Phase 5-6's DepartmentSelect, not this module's job yet.
export type TaskScope = 'all' | 'mine'

export function tasksInScope<T extends Pick<Task, 'owner_id'>>(
  tasks: readonly T[],
  scope: TaskScope,
  myId: string | null,
): readonly T[] {
  if (scope === 'all' || !myId) return tasks
  return tasks.filter((t) => t.owner_id === myId)
}
