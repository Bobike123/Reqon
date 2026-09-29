import { createContext } from 'react'
import type { AssignCandidate } from './AssignTasks.tsx'

// What every Register row needs to offer "Assign existing tasks": the season's
// active tasks and the one presentation mirror of can_edit_task(). Provided once
// by Register.tsx, so the 1,146 memoized rows do not each take new props (and
// re-render) whenever the task list changes. Null = linking is not offered
// (someone not on the roster).
export type AssignContextValue = {
  candidates: readonly AssignCandidate[]
  canEdit: (task: AssignCandidate) => boolean
}

export const AssignContext = createContext<AssignContextValue | null>(null)
