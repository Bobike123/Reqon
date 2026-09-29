import type { Database } from '../lib/database.types.ts'

// The task domain's own type aliases (Phase 6 §6.5) — generated schema types
// stay near the infrastructure boundary (database.types.ts), but a pure
// model (boardModel.ts, ganttModel.ts) or a presentation-only module
// (taskState.ts) should not have to import a React Query hook file just to
// name this type. data/useTasks.ts re-exports these for its own consumers.
export type Task = Database['public']['Tables']['tasks']['Row']
export type TaskState = Database['public']['Enums']['task_state']
export type TaskPriority = Database['public']['Enums']['task_priority']
