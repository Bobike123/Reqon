import { describe, expect, it } from 'vitest'
import { DEFAULT_TASK_FILTER, filterTasks, isDefaultTaskFilter, taskFilterFromParams, taskFilterToParams, taskScopeCounts } from './filters.ts'
import type { Task } from './types.ts'

function t(id: string, owner: string | null, dept: string | null): Task {
  return { id, owner_id: owner, subteam_key: dept } as Task
}
const tasks = [t('a1', 'me', 'AERO'), t('a2', 'other', 'AERO'), t('b1', 'me', 'BODY'), t('b2', 'other', 'BODY'), t('n1', null, null)]
const ids = (list: Task[]) => list.map((x) => x.id)
const depts = [
  { key: 'AERO', name: 'Aero', archived_at: null },
  { key: 'OLD', name: 'Old', archived_at: '2026-01-01' },
]

describe('filterTasks: scope and department are independent', () => {
  it.each([
    ['all', 'all', ['a1', 'a2', 'b1', 'b2', 'n1']],
    ['mine', 'all', ['a1', 'b1']],
    ['all', 'AERO', ['a1', 'a2']],
    ['mine', 'AERO', ['a1']],
    ['mine', 'BODY', ['b1']],
    ['all', 'NOPE', []],
  ] as const)('%s + %s', (scope, department, expected) => {
    expect(ids(filterTasks(tasks, { scope, department }, 'me'))).toEqual([...expected])
  })

  it('"my tasks" is the owner, and with no viewer falls back to showing everything', () => {
    expect(ids(filterTasks(tasks, { scope: 'mine', department: 'all' }, null))).toHaveLength(5)
  })

  it('counts each scope under a department', () => {
    expect(taskScopeCounts(tasks, 'BODY', 'me')).toEqual({ all: 2, mine: 1 })
  })
})

describe('the address', () => {
  const parse = (qs: string) => taskFilterFromParams(new URLSearchParams(qs), depts)

  it('reads scope and department, including an archived department', () => {
    expect(parse('scope=mine&dept=AERO')).toEqual({ filter: { scope: 'mine', department: 'AERO' }, notice: null })
    expect(parse('dept=OLD').filter.department).toBe('OLD')
  })

  it('never silently accepts an unknown value', () => {
    expect(parse('dept=DELETED')).toMatchObject({ filter: { department: 'all' }, notice: expect.stringContaining('DELETED') })
    expect(parse('scope=admin')).toMatchObject({ filter: { scope: 'all' }, notice: expect.stringContaining('admin') })
  })

  it('writes only non-default values and round-trips', () => {
    expect(taskFilterToParams(DEFAULT_TASK_FILTER).toString()).toBe('')
    const filter = { scope: 'mine' as const, department: 'AERO' }
    expect(taskFilterToParams(filter).toString()).toBe('scope=mine&dept=AERO')
    expect(parse(taskFilterToParams(filter).toString()).filter).toEqual(filter)
    expect(isDefaultTaskFilter(filter)).toBe(false)
    expect(isDefaultTaskFilter(DEFAULT_TASK_FILTER)).toBe(true)
  })
})
