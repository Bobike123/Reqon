import { describe, expect, it } from 'vitest'
import type { Milestone, MilestoneSection } from '../../data/useMilestones.ts'
import type { Task, TaskState } from '../../data/useTasks.ts'
import {
  milestonePercent,
  milestoneSpan,
  monthTicks,
  placeBar,
  placeDay,
  progressOf,
  sectionPercent,
  sectionSpan,
  spanOfDates,
  timelineRange,
} from './ganttModel.ts'

const TODAY = '2026-09-13'

function ms(over: Partial<Milestone> & { key: string }): Milestone {
  return {
    key: over.key, season_id: 's', ordinal: 1, name: over.key, aim: null,
    article_ref: null, opens_on: over.opens_on ?? null, due_on: over.due_on ?? null,
    max_points: 0, is_blocking: false, notes: null,
  } as Milestone
}

function section(id: string, drafted = false): MilestoneSection {
  return { id, milestone_key: 'MS1-1', ordinal: 1, name: id, is_drafted: drafted,
    owner_id: null, updated_at: '' } as MilestoneSection
}

function task(id: string, state: TaskState, sectionId: string | null, due: string | null = null): Task {
  return { id, season_id: 's', title: id, state, section_id: sectionId, due_date: due,
    owner_id: null, detail: null, starred: false, subteam_key: null, source_proposal: null,
    created_at: '', created_by: null, updated_at: '' } as Task
}

describe('timeline range', () => {
  it('widens to whole months so the ruler lines up with the bars', () => {
    expect(timelineRange(['2026-11-12', '2027-02-03'], TODAY)).toEqual({
      from: '2026-09-01',
      to: '2027-02-28',
    })
  })

  it('always contains today, even when every date is in the past', () => {
    expect(timelineRange(['2025-01-10'], TODAY)).toEqual({ from: '2025-01-01', to: '2026-09-30' })
  })

  it('survives a season with no dates at all', () => {
    expect(timelineRange([null, undefined, ''], TODAY)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })
})

describe('placing a bar', () => {
  const range = { from: '2026-01-01', to: '2026-01-10' } // ten days

  it('measures from the left edge, both ends inclusive', () => {
    expect(placeBar({ from: '2026-01-01', to: '2026-01-05' }, range)).toEqual({ left: 0, width: 50 })
  })

  it('gives a single day real width instead of nothing to see', () => {
    expect(placeBar({ from: '2026-01-10', to: '2026-01-10' }, range)).toEqual({ left: 90, width: 10 })
  })

  it('clips a span that hangs over an edge rather than overflowing the track', () => {
    expect(placeBar({ from: '2025-12-01', to: '2026-01-02' }, range)).toEqual({ left: 0, width: 20 })
  })

  it('draws nothing for a span entirely outside the chart', () => {
    expect(placeBar({ from: '2026-02-01', to: '2026-02-02' }, range)).toBeNull()
  })

  it('tolerates a span recorded back to front', () => {
    expect(placeBar({ from: '2026-01-05', to: '2026-01-01' }, range)).toEqual({ left: 0, width: 50 })
  })

  it('places today for the marker line', () => {
    expect(placeDay('2026-01-06', range)).toBe(50)
    expect(placeDay('2027-01-06', range)).toBeNull()
  })
})

describe('month ruler', () => {
  it('labels every month in the range and covers it end to end', () => {
    const ticks = monthTicks({ from: '2026-11-01', to: '2027-01-31' })
    expect(ticks.map((t) => t.key)).toEqual(['2026-11', '2026-12', '2027-01'])
    expect(ticks[0].left).toBe(0)
    // 30 + 31 + 31 = 92 days, and the last tick must end exactly at the edge.
    const last = ticks[2]
    expect(Math.round(last.left + last.width)).toBe(100)
  })

  it('rolls December over into the next year', () => {
    expect(monthTicks({ from: '2026-12-01', to: '2027-01-31' }).map((t) => t.key)).toEqual([
      '2026-12',
      '2027-01',
    ])
  })
})

describe('progress', () => {
  it('counts done against everything still alive', () => {
    expect(progressOf([task('a', 'done', 's1'), task('b', 'wip', 's1')])).toEqual({
      done: 1, total: 2, percent: 50,
    })
  })

  it('drops cancelled work from both sides, so it never reads 0% forever', () => {
    expect(progressOf([task('a', 'done', 's1'), task('b', 'cancelled', 's1')])).toEqual({
      done: 1, total: 1, percent: 100,
    })
  })

  it('says "nothing to count" with null, which is not the same as 0%', () => {
    expect(progressOf([]).percent).toBeNull()
    expect(progressOf([task('a', 'cancelled', 's1')]).percent).toBeNull()
  })
})

describe('rolling up to sections and submissions', () => {
  const sections = [section('s1'), section('s2', true)]
  const tasks = [
    task('a', 'done', 's1'),
    task('b', 'todo', 's1'),
    task('c', 'todo', null), // a board task belonging to no section
  ]

  it('takes a section’s percentage from its own subtasks', () => {
    expect(sectionPercent(sections[0], tasks)).toBe(50)
  })

  it('falls back to the drafted tick where a section has no subtasks', () => {
    expect(sectionPercent(sections[1], tasks)).toBe(100)
    expect(sectionPercent(section('s3'), tasks)).toBe(0)
  })

  it('rolls a submission up from every subtask beneath it, ignoring loose tasks', () => {
    // 1 of 2 done under s1; task 'c' is on the Board but under no section.
    expect(milestonePercent(sections, tasks)).toBe(50)
  })

  it('falls back to sections drafted when no subtask exists anywhere', () => {
    expect(milestonePercent(sections, [])).toBe(50) // s2 drafted, s1 not
    expect(milestonePercent([], [])).toBe(0)
  })
})

describe('spans', () => {
  it('reads a submission window, and refuses to invent one', () => {
    expect(milestoneSpan(ms({ key: 'MS1-1', opens_on: '2026-11-01', due_on: '2026-11-30' })))
      .toEqual({ from: '2026-11-01', to: '2026-11-30' })
    // No opening date published: the bar is the due day itself, not a guess.
    expect(milestoneSpan(ms({ key: 'MS1-2', due_on: '2026-11-30' })))
      .toEqual({ from: '2026-11-30', to: '2026-11-30' })
    expect(milestoneSpan(ms({ key: 'MS1-7' }))).toBeNull()
  })

  it('spans the dates it has and ignores the ones it does not', () => {
    expect(spanOfDates(['2026-03-01', null, '2026-01-09', undefined])).toEqual({
      from: '2026-01-09', to: '2026-03-01',
    })
    expect(spanOfDates([null])).toBeNull()
  })

  it('gives a section the span of its dated subtasks', () => {
    const tasks = [task('a', 'todo', 's1', '2026-02-10'), task('b', 'todo', 's1', '2026-02-20')]
    expect(sectionSpan(tasks, 's1', null)).toEqual({ from: '2026-02-10', to: '2026-02-20' })
  })

  it('borrows the submission window when no subtask has a date', () => {
    const parent = { from: '2026-11-01', to: '2026-11-30' }
    expect(sectionSpan([task('a', 'todo', 's1')], 's1', parent)).toEqual(parent)
    expect(sectionSpan([], 's1', null)).toBeNull()
  })
})
