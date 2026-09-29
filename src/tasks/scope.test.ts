import { describe, expect, it } from 'vitest'
import { tasksInScope } from './scope.ts'
import type { Task } from './types.ts'

function task(id: string, ownerId: string | null): Task {
  return {
    id, season_id: 's', title: id, detail: null, owner_id: ownerId, subteam_key: null,
    due_date: null, starts_on: null, state: 'todo', priority: 'normal', starred: false,
    source_proposal: null, created_by: null, created_at: '', updated_at: '',
    section_id: null, completed_at: null, completion_source: null,
    archived_at: null, archived_by: null, archive_reason: null,
    milestone_key: null, links_required: false,
  }
}

describe('tasksInScope', () => {
  const tasks = [task('t1', 'me'), task('t2', 'other'), task('t3', null)]

  it("'all' never hides a task, regardless of who is asking", () => {
    expect(tasksInScope(tasks, 'all', 'me')).toEqual(tasks)
    expect(tasksInScope(tasks, 'all', null)).toEqual(tasks)
  })

  it("'mine' keeps only the caller's own tasks", () => {
    expect(tasksInScope(tasks, 'mine', 'me').map((t) => t.id)).toEqual(['t1'])
  })

  it("'mine' with no signed-in id falls back to showing everything", () => {
    expect(tasksInScope(tasks, 'mine', null)).toEqual(tasks)
  })
})
