import { describe, expect, it } from 'vitest'
import { milestoneMarks, milestoneSummary, planningDates, taskMark, taskSummary } from './ganttMarks.ts'

const TODAY = '2026-11-15'
const t = (over: Partial<{ starts_on: string | null; due_date: string | null; state: 'todo' | 'wip' | 'blocked' | 'done' | 'cancelled'; title: string }> = {}) => ({
  starts_on: null, due_date: null, state: 'todo' as const, title: 'Task', ...over,
})

describe('taskMark: which shape a task draws as', () => {
  it('both dates make a period', () => {
    expect(taskMark(t({ starts_on: '2026-11-20', due_date: '2026-11-25' }), TODAY)).toEqual({
      kind: 'period', span: { from: '2026-11-20', to: '2026-11-25' }, overdue: false, done: false,
    })
  })

  it('a deadline alone is a deadline marker: no start date is invented', () => {
    const mark = taskMark(t({ due_date: '2026-11-25' }), TODAY)
    expect(mark).toEqual({ kind: 'deadline', day: '2026-11-25', overdue: false, done: false })
    expect('span' in mark).toBe(false)
  })

  it('a start alone is a start marker, with no deadline invented', () => {
    expect(taskMark(t({ starts_on: '2026-11-20' }), TODAY)).toEqual({ kind: 'start-only', day: '2026-11-20', done: false })
  })

  it('no dates at all is undated, and draws nothing', () => {
    expect(taskMark(t(), TODAY)).toEqual({ kind: 'undated', done: false })
  })

  it('still draws a period if a bad row ever has its dates reversed', () => {
    const mark = taskMark(t({ starts_on: '2026-11-25', due_date: '2026-11-20' }), TODAY)
    expect(mark).toMatchObject({ kind: 'period', span: { from: '2026-11-20', to: '2026-11-25' } })
  })

  it('reads the calendar day out of a longer stored value without a time-zone shift', () => {
    const mark = taskMark(t({ due_date: '2026-11-25T23:30:00+00:00' }), TODAY)
    expect(mark).toMatchObject({ kind: 'deadline', day: '2026-11-25' })
  })

  describe('overdue (one definition, shared with the Board)', () => {
    it('is late only when the day has passed', () => {
      expect(taskMark(t({ due_date: '2026-11-14' }), TODAY)).toMatchObject({ overdue: true })
      expect(taskMark(t({ due_date: '2026-11-15' }), TODAY)).toMatchObject({ overdue: false }) // due today is not late
      expect(taskMark(t({ due_date: '2026-11-16' }), TODAY)).toMatchObject({ overdue: false })
    })

    it('a period is late by its deadline, not its start', () => {
      expect(taskMark(t({ starts_on: '2026-11-01', due_date: '2026-11-20' }), TODAY)).toMatchObject({ kind: 'period', overdue: false })
      expect(taskMark(t({ starts_on: '2026-11-01', due_date: '2026-11-10' }), TODAY)).toMatchObject({ kind: 'period', overdue: true })
    })

    it('finished and cancelled work is never overdue', () => {
      expect(taskMark(t({ due_date: '2026-11-01', state: 'done' }), TODAY)).toMatchObject({ overdue: false, done: true })
      expect(taskMark(t({ due_date: '2026-11-01', state: 'cancelled' }), TODAY)).toMatchObject({ overdue: false, done: false })
    })
  })
})

describe('taskSummary: the same fact in words', () => {
  it('says each shape, and never states an invented date', () => {
    expect(taskSummary(t({ title: 'A', starts_on: '2026-11-20', due_date: '2026-11-25', state: 'wip' }), TODAY)).toBe('A: 20 Nov 2026 to 25 Nov 2026, In progress')
    expect(taskSummary(t({ title: 'B', due_date: '2026-11-25' }), TODAY)).toBe('B: deadline 25 Nov 2026 (no start date), To do')
    expect(taskSummary(t({ title: 'C', starts_on: '2026-11-20' }), TODAY)).toBe('C: starts 20 Nov 2026 (no deadline), To do')
    expect(taskSummary(t({ title: 'D' }), TODAY)).toBe('D: no dates set, To do')
  })

  it('says overdue in words', () => {
    expect(taskSummary(t({ title: 'E', due_date: '2026-11-01' }), TODAY)).toBe('E: deadline 1 Nov 2026 (no start date), To do, overdue')
  })
})

describe('milestoneMarks', () => {
  it('a window needs BOTH ends; the deadline is separate', () => {
    expect(milestoneMarks({ opens_on: '2026-11-01', due_on: '2026-11-30' }, TODAY)).toEqual({
      window: { from: '2026-11-01', to: '2026-11-30' }, deadline: '2026-11-30', opensOnly: null, passed: false,
    })
  })

  it('with no opening date there is no window, and none is invented from the deadline', () => {
    const marks = milestoneMarks({ opens_on: null, due_on: '2027-02-28' }, TODAY)
    expect(marks.window).toBeNull()
    expect(marks.deadline).toBe('2027-02-28')
  })

  it('an opening date with no deadline is text only, never a bar', () => {
    expect(milestoneMarks({ opens_on: '2026-11-01', due_on: null }, TODAY)).toMatchObject({ window: null, deadline: null, opensOnly: '2026-11-01', passed: false })
  })

  it('no dates at all is TBC', () => {
    expect(milestoneMarks({ opens_on: null, due_on: null }, TODAY)).toEqual({ window: null, deadline: null, opensOnly: null, passed: false })
  })

  it('passed means the deadline day is before today; today itself has not passed', () => {
    expect(milestoneMarks({ opens_on: null, due_on: '2026-11-14' }, TODAY).passed).toBe(true)
    expect(milestoneMarks({ opens_on: null, due_on: '2026-11-15' }, TODAY).passed).toBe(false)
  })
})

describe('milestoneSummary', () => {
  const m = { key: 'MS1-1', name: 'Team Plan' }
  it('describes every case in words', () => {
    expect(milestoneSummary({ ...m, opens_on: '2026-11-01', due_on: '2026-11-30' }, TODAY, '1 of 2 tasks done')).toBe(
      'MS1-1 Team Plan: submission window 1 Nov 2026 to 30 Nov 2026, deadline 30 Nov 2026, 1 of 2 tasks done',
    )
    expect(milestoneSummary({ ...m, opens_on: null, due_on: '2026-11-30' }, TODAY, 'No linked work')).toBe(
      'MS1-1 Team Plan: no opening date published, deadline 30 Nov 2026, No linked work',
    )
    expect(milestoneSummary({ ...m, opens_on: null, due_on: null }, TODAY, 'No linked work')).toBe(
      'MS1-1 Team Plan: deadline TBC (not yet published), No linked work',
    )
    expect(milestoneSummary({ ...m, opens_on: '2026-11-01', due_on: null }, TODAY, 'x')).toContain('opens 1 Nov 2026, deadline TBC')
    expect(milestoneSummary({ ...m, opens_on: null, due_on: '2026-11-01' }, TODAY, 'x')).toContain('deadline 1 Nov 2026 (passed)')
  })
})

describe('planningDates', () => {
  it('includes task starts and ends and milestone opens and deadlines', () => {
    expect(
      planningDates([{ opens_on: '2026-11-01', due_on: '2026-11-30' }], [{ starts_on: '2026-09-15', due_date: '2026-10-01' }]),
    ).toEqual(['2026-11-01', '2026-11-30', '2026-09-15', '2026-10-01'])
  })
})
