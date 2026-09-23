import type { TaskState } from './types.ts'

// One domain-owned definition of the task_state enum's presentation and
// behaviour (Phase 6 §6.7). Before this, Board.tsx (LANES), Gantt.tsx
// (STATES + a separate BAR_TONE map) and PromoteDialog.tsx (START_LANES)
// each carried their own copy of the same six states, in slightly different
// shapes — Board and Gantt's own comment already said as much: "If a seventh
// state is ever added to the enum it belongs in both places — or, better,
// the two lists become one." This is that one list.
//
// The database enum (supabase/migrations/20260101000000_paddock_control_schema.sql)
// remains the authority on which values may be PERSISTED — this only decides
// how an already-valid state is shown and where it may be entered from.
export type TaskStateMeta = {
  state: TaskState
  label: string
  // Board lane / move-dropdown order.
  order: number
  boardTone: string
  ganttBarTone: string
  // Whether promoting a proposal may start a task directly in this state.
  // Promoting straight into Done or Cancelled would record work that never
  // happened, so those are false.
  creationEligible: boolean
}

export const TASK_STATES: readonly TaskStateMeta[] = [
  { state: 'urgent', label: 'Urgent', order: 0, boardTone: 'border-red-300 bg-red-50', ganttBarTone: 'bg-red-500', creationEligible: true },
  { state: 'todo', label: 'To do', order: 1, boardTone: 'border-slate-200 bg-white', ganttBarTone: 'bg-slate-400', creationEligible: true },
  { state: 'wip', label: 'In progress', order: 2, boardTone: 'border-blue-200 bg-blue-50', ganttBarTone: 'bg-blue-500', creationEligible: true },
  { state: 'blocked', label: 'Blocked', order: 3, boardTone: 'border-amber-300 bg-amber-50', ganttBarTone: 'bg-amber-500', creationEligible: false },
  { state: 'done', label: 'Done', order: 4, boardTone: 'border-green-200 bg-green-50', ganttBarTone: 'bg-green-600', creationEligible: false },
  { state: 'cancelled', label: 'Cancelled', order: 5, boardTone: 'border-slate-200 bg-slate-100', ganttBarTone: 'bg-slate-300', creationEligible: false },
]

function metaMap<V>(pick: (meta: TaskStateMeta) => V): Record<TaskState, V> {
  return Object.fromEntries(TASK_STATES.map((meta) => [meta.state, pick(meta)])) as Record<TaskState, V>
}

export const TASK_STATE_LABEL: Record<TaskState, string> = metaMap((m) => m.label)
export const TASK_STATE_BOARD_TONE: Record<TaskState, string> = metaMap((m) => m.boardTone)
export const TASK_STATE_GANTT_TONE: Record<TaskState, string> = metaMap((m) => m.ganttBarTone)

// The states a promoted proposal may start in, in the board-lane order above.
export const TASK_CREATION_STATES: readonly TaskStateMeta[] = TASK_STATES.filter((m) => m.creationEligible)
