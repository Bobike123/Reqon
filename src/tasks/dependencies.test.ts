import { describe, expect, it } from 'vitest'
import { dependentsOf, isSatisfied, openPrerequisites, prerequisiteCandidates, prerequisitesOf, scheduleConflict, taskRefLookup, waitersOf, type TaskLink, type TaskRef } from './dependencies.ts'

function ref(id: string, over: Partial<TaskRef> = {}): TaskRef {
  return { id, title: id.toUpperCase(), state: 'todo', due_date: null, starts_on: null, subteam_key: 'AERO', archived_at: null, ...over }
}
const link = (task: string, dependsOn: string): TaskLink => ({ task_id: task, depends_on_task_id: dependsOn })

describe('prerequisites and dependents', () => {
  const tasks = [ref('a'), ref('b'), ref('c')]
  const byId = new Map(tasks.map((t) => [t.id, t]))

  it('lists what a task waits for and what waits for it, by title', () => {
    const links = [link('a', 'c'), link('a', 'b'), link('b', 'c')]
    expect(prerequisitesOf(links, 'a', byId).map((t) => t.id)).toEqual(['b', 'c'])
    expect(dependentsOf(links, 'c', byId).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('shows a link to a task that is no longer in the active list as an archived task, not nothing', () => {
    const [only] = prerequisitesOf([link('a', 'gone')], 'a', byId)
    expect(only).toMatchObject({ id: 'gone', title: 'An archived task' })
    expect(isSatisfied(only)).toBe(true)
  })

  it('names an archived prerequisite when the archived tasks are supplied, and lets an active row win', () => {
    const lookup = taskRefLookup(
      [...byId.values()],
      [
        { id: 'gone', title: 'Finished weeks ago', state: 'done', subteam_key: 'MECH', archived_at: '2026-09-01T00:00:00Z' },
        { id: 'a', title: 'Stale archived copy of a', state: 'done', subteam_key: 'MECH', archived_at: '2026-09-01T00:00:00Z' },
      ],
    )
    const [named] = prerequisitesOf([link('a', 'gone')], 'a', lookup)
    expect(named).toMatchObject({ id: 'gone', title: 'Finished weeks ago', due_date: null })
    expect(isSatisfied(named)).toBe(true)
    expect(lookup.get('a')?.title).toBe(byId.get('a')?.title)
  })
})

describe('circles and candidates', () => {
  it('finds every task that waits for a task, directly or through others', () => {
    // a waits b, b waits c, d waits c
    const links = [link('a', 'b'), link('b', 'c'), link('d', 'c')]
    expect([...waitersOf(links, 'c')].sort()).toEqual(['a', 'b', 'd'])
    expect([...waitersOf(links, 'b')]).toEqual(['a'])
    expect([...waitersOf(links, 'a')]).toEqual([])
  })

  it('terminates on a circle that already exists in the data', () => {
    expect([...waitersOf([link('a', 'b'), link('b', 'a')], 'a')].sort()).toEqual(['a', 'b'])
  })

  it('never offers itself, an archived task, an existing prerequisite, or anything that would close a circle', () => {
    const tasks = [ref('a'), ref('b'), ref('c'), ref('d'), ref('e', { archived_at: '2026-09-01T00:00:00Z' })]
    // a already waits for b; c waits for a
    const links = [link('a', 'b'), link('c', 'a')]
    expect(prerequisiteCandidates({ id: 'a' }, tasks, links).map((t) => t.id)).toEqual(['d'])
  })
})

describe('schedule conflicts (advisory only)', () => {
  const open = { due_date: '2026-10-10', state: 'wip' as const, archived_at: null }

  it('flags a task that starts before an unfinished prerequisite is due', () => {
    expect(scheduleConflict({ starts_on: '2026-10-05', due_date: '2026-10-20' }, open)).toBe(true)
  })

  it('uses the deadline when there is no start, and compares calendar dates exactly', () => {
    expect(scheduleConflict({ starts_on: null, due_date: '2026-10-09' }, open)).toBe(true)
    expect(scheduleConflict({ starts_on: '2026-10-10', due_date: '2026-10-20' }, open)).toBe(false) // same day is not before
  })

  it('does not flag a finished, cancelled or archived prerequisite, or one with no deadline', () => {
    const task = { starts_on: '2026-10-05', due_date: '2026-10-20' }
    expect(scheduleConflict(task, { ...open, state: 'done' })).toBe(false)
    expect(scheduleConflict(task, { ...open, state: 'cancelled' })).toBe(false)
    expect(scheduleConflict(task, { ...open, archived_at: '2026-09-01T00:00:00Z' })).toBe(false)
    expect(scheduleConflict(task, { ...open, due_date: null })).toBe(false)
  })

  it('counts only unfinished prerequisites as open', () => {
    expect(openPrerequisites([ref('a', { state: 'done' }), ref('b'), ref('c', { state: 'cancelled' })]).map((t) => t.id)).toEqual(['b'])
  })
})
