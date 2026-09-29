import type { TaskPriority } from '../tasks/types.ts'

// What a NEW proposal must carry (ADR-0005, mirrored from submit_proposal()).
// The database refuses an incomplete one on every path; this module only lets
// a form say WHAT is missing before a round trip, and lets the data layer
// refuse to send a request it already knows is invalid. Pure and dependency
// free so a form, a hook and a test can all use it.
export type NewProposal = {
  title: string
  description?: string | null
  departmentKey: string
  // YYYY-MM-DD — a calendar date, never an instant.
  dueDate: string
  milestoneKey: string
  // clauses.clause_key values, never printed references (not unique).
  requirementKeys: string[]
  priority?: TaskPriority
  ownerId?: string | null
}

export type SubmissionProblem = 'title' | 'department' | 'dueDate' | 'milestone' | 'requirement'

export const MAX_TITLE_LENGTH = 200
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function submissionProblems(input: Partial<NewProposal>): SubmissionProblem[] {
  const problems: SubmissionProblem[] = []
  const title = (input.title ?? '').trim()
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) problems.push('title')
  if (!input.departmentKey) problems.push('department')
  if (!input.dueDate || !DATE_ONLY.test(input.dueDate) || Number.isNaN(Date.parse(input.dueDate))) {
    problems.push('dueDate')
  }
  if (!input.milestoneKey) problems.push('milestone')
  if (new Set(input.requirementKeys ?? []).size < 1) problems.push('requirement')
  return problems
}

export const PROBLEM_LABEL: Record<SubmissionProblem, string> = {
  title: 'a title',
  department: 'a department',
  dueDate: 'a deadline',
  milestone: 'a milestone',
  requirement: 'at least one requirement',
}

// The sentence shown next to a field that is missing or invalid.
export const PROBLEM_MESSAGE: Record<SubmissionProblem, string> = {
  title: `Enter a title of 1 to ${MAX_TITLE_LENGTH} characters.`,
  department: 'Choose the department this is for.',
  dueDate: 'Choose a deadline. It is never filled in for you.',
  milestone: 'Choose the milestone it belongs to.',
  requirement: 'Choose at least one requirement it serves.',
}
