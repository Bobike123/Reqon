import type { TaskPriority } from './types.ts'

// One domain-owned definition of task_priority's presentation (Phase 2,
// mirroring taskState.ts's pattern for task_state). Priority and state are
// orthogonal (ADR-0004): a task can be Blocked AND Urgent, so this is a
// separate badge, never a seventh board lane.
export const TASK_PRIORITIES: readonly TaskPriority[] = ['normal', 'urgent']

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  normal: 'Normal',
  urgent: 'Urgent',
}

// Shown as a small badge on a card — only urgent work gets one, so normal
// priority renders nothing rather than a redundant "Normal" tag everywhere.
export const TASK_PRIORITY_BADGE_TONE: Record<TaskPriority, string> = {
  normal: '',
  urgent: 'bg-red-100 text-red-800',
}

export function isUrgent(priority: TaskPriority): boolean {
  return priority === 'urgent'
}
