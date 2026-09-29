import { describe, expect, it } from 'vitest'
import { taskProgress, tasksInMilestone } from './progress.ts'

const t = (id: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ id, state, archived_at: null, section_id: null, milestone_key: null, ...extra }) as never

describe('taskProgress (one rule, ADR-0006)', () => {
  it('reports "no linked work" (null), never 0% or 100%, when there is nothing to count', () => {
    expect(taskProgress([])).toEqual({ done: 0, total: 0, percent: null, archivedUnfinished: 0 })
    expect(taskProgress([t('a', 'cancelled')])).toEqual({ done: 0, total: 0, percent: null, archivedUnfinished: 0 })
  })

  it('counts a task once even if it is passed twice', () => {
    expect(taskProgress([t('a', 'done'), t('a', 'done'), t('b', 'todo')])).toMatchObject({ done: 1, total: 2, percent: 50 })
  })

  it('excludes cancelled work from both sides', () => {
    expect(taskProgress([t('a', 'done'), t('b', 'cancelled')])).toMatchObject({ done: 1, total: 1, percent: 100 })
  })

  it('counts an archived Done task as complete', () => {
    const done = t('a', 'done', { archived_at: '2026-09-01T00:00:00Z' })
    expect(taskProgress([done, t('b', 'todo')])).toMatchObject({ done: 1, total: 2, archivedUnfinished: 0 })
  })

  it('keeps archived unfinished work in the denominator and reports it separately', () => {
    const stale = t('a', 'wip', { archived_at: '2026-09-01T00:00:00Z' })
    expect(taskProgress([stale, t('b', 'done')])).toEqual({ done: 1, total: 2, percent: 50, archivedUnfinished: 1 })
  })
})

describe('tasksInMilestone', () => {
  const sections = new Set(['sec-1'])

  it('includes an unsectioned task attached to the milestone', () => {
    const tasks = [t('a', 'todo', { milestone_key: 'MS1' })]
    expect(tasksInMilestone(tasks, 'MS1', sections)).toHaveLength(1)
  })

  it('does not double-count a task that has both the key and a section of the milestone', () => {
    const tasks = [t('a', 'todo', { milestone_key: 'MS1', section_id: 'sec-1' })]
    expect(tasksInMilestone(tasks, 'MS1', sections)).toHaveLength(1)
  })

  it('still finds a legacy task that has only a section', () => {
    const tasks = [t('a', 'todo', { section_id: 'sec-1' })]
    expect(tasksInMilestone(tasks, 'MS1', sections)).toHaveLength(1)
  })

  it('leaves other milestones\' tasks out', () => {
    const tasks = [t('a', 'todo', { milestone_key: 'MS2' }), t('b', 'todo', { section_id: 'other' })]
    expect(tasksInMilestone(tasks, 'MS1', sections)).toEqual([])
  })
})
