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
  rangeDays,
  sectionPercent,
  sectionSpan,
  shiftDay,
  spanOfDates,
  timelineRange,
  weekTicks,
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

describe('week ruler', () => {
  it('starts on the Monday on or before the range and covers it end to end', () => {
    // 2026-11-01 is a Sunday, so the first week starts Monday 2026-10-26 and is
    // clipped to a single day inside the range.
    const ticks = weekTicks({ from: '2026-11-01', to: '2026-11-30' })
    expect(ticks[0].key).toBe('2026-10-26')
    expect(ticks[0].left).toBe(0)
    expect(ticks[1].key).toBe('2026-11-02')
    const last = ticks[ticks.length - 1]
    expect(Math.round(last.left + last.width)).toBe(100)
  })

  it('needs no clipping when the range already begins on a Monday', () => {
    expect(weekTicks({ from: '2027-01-04', to: '2027-01-17' }).map((t) => t.key)).toEqual([
      '2027-01-04',
      '2027-01-11',
    ])
  })
})

describe('progress', () => {
  it('counts done against everything still alive', () => {
    expect(progressOf([task('a', 'done', 's1'), task('b', 'wip', 's1')])).toMatchObject({
      done: 1, total: 2, percent: 50, archivedUnfinished: 0,
    })
  })

  it('drops cancelled work from both sides, so it never reads 0% forever', () => {
    expect(progressOf([task('a', 'done', 's1'), task('b', 'cancelled', 's1')])).toMatchObject({
      done: 1, total: 1, percent: 100, archivedUnfinished: 0,
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

  it('counts an ARCHIVED Done task as complete and keeps an archived unfinished one in the denominator', () => {
    const progress = [
      { id: 'a', state: 'done', archived_at: '2026-09-01T00:00:00Z', section_id: null, milestone_key: 'MS1' },
      { id: 'b', state: 'wip', archived_at: '2026-09-01T00:00:00Z', section_id: null, milestone_key: 'MS1' },
      { id: 'c', state: 'done', archived_at: null, section_id: null, milestone_key: 'MS1' },
      { id: 'd', state: 'cancelled', archived_at: null, section_id: null, milestone_key: 'MS1' },
    ] as never[]
    // done: a, c of 3 counted (b unfinished; cancelled d leaves entirely)
    expect(milestonePercent([], progress, 'MS1')).toBe(67)
  })

  it('counts an unsectioned task attached to the milestone once, and a sectioned one once', () => {
    const progress = [
      { id: 'x', state: 'done', archived_at: null, section_id: null, milestone_key: 'MS1' },
      { id: 'y', state: 'todo', archived_at: null, section_id: sections[0].id, milestone_key: 'MS1' },
    ] as never[]
    expect(milestonePercent(sections, progress, 'MS1')).toBe(50)
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

// ------------------------------------------------------------ date boundaries
// The chart works on YYYY-MM-DD strings and whole-day arithmetic in UTC, so no
// reader's time zone or daylight-saving change can move a bar by a day. These
// pin the places an off-by-one would show: month ends, the year turn, a leap
// day, and the Sundays clocks change.
describe('month and year boundaries', () => {
  it('widens across the year turn without dropping December or January', () => {
    const range = timelineRange(['2026-12-31', '2027-01-01'], '2026-12-15')
    expect(range).toEqual({ from: '2026-12-01', to: '2027-01-31' })
    expect(monthTicks(range).map((t) => t.key)).toEqual(['2026-12', '2027-01'])
  })

  it('a leap February is 29 days wide, a normal one 28', () => {
    const leap = monthTicks({ from: '2028-02-01', to: '2028-03-31' })
    expect(leap[0].key).toBe('2028-02')
    // 29 + 31 = 60 days: February is 29/60 of the track.
    expect(leap[0].width).toBeCloseTo((29 / 60) * 100, 6)
    const normal = monthTicks({ from: '2027-02-01', to: '2027-03-31' })
    expect(normal[0].width).toBeCloseTo((28 / 59) * 100, 6)
  })

  it('places the last day of a month and the first of the next in adjacent columns', () => {
    const range = { from: '2026-01-01', to: '2026-02-28' } // 59 days
    expect(placeDay('2026-01-31', range)).toBeCloseTo((30 / 59) * 100, 6)
    expect(placeDay('2026-02-01', range)).toBeCloseTo((31 / 59) * 100, 6)
  })

  it('draws a period across a month boundary as one bar, both ends inclusive', () => {
    const range = { from: '2026-01-01', to: '2026-02-28' }
    const box = placeBar({ from: '2026-01-31', to: '2026-02-01' }, range)
    expect(box?.left).toBeCloseTo((30 / 59) * 100, 6)
    expect(box?.width).toBeCloseTo((2 / 59) * 100, 6)
  })

  it('does not clip a period that ends exactly on the last day of the range', () => {
    const range = timelineRange(['2026-11-20', '2026-12-31'], '2026-11-25')
    expect(placeBar({ from: '2026-12-31', to: '2026-12-31' }, range)).not.toBeNull()
    expect(placeBar({ from: '2026-11-20', to: '2026-12-31' }, range)?.width).toBeGreaterThan(0)
  })

  it('a start before every deadline pulls the range back to the start\'s own month', () => {
    // Deadlines only would give Nov–Dec; the start in September must be included.
    expect(timelineRange(['2026-09-15', '2026-11-20', '2026-12-05'], '2026-11-25').from).toBe('2026-09-01')
  })
})

describe('daylight-saving weeks', () => {
  // Europe changes clocks on Sunday 29 Mar and 25 Oct 2026, so those weeks have
  // 167 or 169 hours in local time. Whole-day UTC arithmetic keeps every week 7 days.
  it.each([
    ['spring forward', { from: '2026-03-16', to: '2026-04-12' }],
    ['fall back', { from: '2026-10-12', to: '2026-11-08' }],
  ])('every full week is seven days wide across %s', (_name, range) => {
    const ticks = weekTicks(range)
    const total = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1
    const full = ticks.filter((t) => t.width > 0)
    // Interior weeks (not clipped at either edge) are exactly 7/total wide.
    for (const tick of full.slice(1, -1)) expect(tick.width).toBeCloseTo((7 / total) * 100, 6)
    // Consecutive week keys are exactly seven calendar days apart.
    for (let i = 1; i < ticks.length; i += 1) {
      const gap = (Date.parse(`${ticks[i].key}T00:00:00Z`) - Date.parse(`${ticks[i - 1].key}T00:00:00Z`)) / 86_400_000
      expect(gap).toBe(7)
    }
  })

  it('a deadline on the changeover Sunday sits on that day, not the next', () => {
    const range = { from: '2026-03-23', to: '2026-04-05' } // 14 days
    expect(placeDay('2026-03-29', range)).toBeCloseTo((6 / 14) * 100, 6)
    expect(placeDay('2026-03-30', range)).toBeCloseTo((7 / 14) * 100, 6)
  })
})

describe('a section\'s span uses starts as well as deadlines', () => {
  it('begins at the earliest start, not the earliest deadline', () => {
    const tasks = [
      { ...task('a', 'todo', 's1', '2026-11-20'), starts_on: '2026-11-02' },
      task('b', 'todo', 's1', '2026-11-25'),
    ] as Task[]
    expect(sectionSpan(tasks, 's1', null)).toEqual({ from: '2026-11-02', to: '2026-11-25' })
  })
})

describe('rangeDays and shiftDay (dragging a bar)', () => {
  it('counts both ends of a range', () => {
    expect(rangeDays({ from: '2026-10-01', to: '2026-10-01' })).toBe(1)
    expect(rangeDays({ from: '2026-10-01', to: '2026-10-31' })).toBe(31)
  })
  it('moves a calendar day by whole days across months, years and the DST change, never by a time zone', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2026-03-29', -1)).toBe('2026-03-28')
    expect(shiftDay('2026-10-25', 0)).toBe('2026-10-25')
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29')
  })
})
