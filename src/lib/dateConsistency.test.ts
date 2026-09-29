import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Milestone } from '../data/useMilestones.ts'
import { isOverdue } from '../pages/board/boardModel.ts'
import { submissionWindow } from '../pages/milestones/milestoneModel.ts'
import { nextDeadline } from '../pages/now/nowModel.ts'
import { milestoneMarks, taskMark } from '../pages/gantt/ganttMarks.ts'
import { toLocalDateString } from './dates.ts'

// Board, Now, Milestones and Gantt (Gantt draws milestoneModel's own
// submissionWindow — see pages/Gantt.tsx) each ask a different model whether
// a deadline has passed, but every one of them is required to agree, because
// they all describe the SAME calendar. This proves that agreement directly,
// for the one instant that used to be able to break it: an instant near local
// midnight, read in a time zone other than UTC.

function ms(due: string): Milestone {
  return {
    key: 'MS1-1', season_id: 's', ordinal: 1, name: 'MS1-1', aim: null, article_ref: null,
    opens_on: null, due_on: due, max_points: 75, is_blocking: false, notes: null,
  } as Milestone
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the same deadline produces the same status on every screen', () => {
  it('agrees a deadline of "today" has not passed, near local midnight at a positive UTC offset', () => {
    vi.stubEnv('TZ', 'Pacific/Kiritimati') // UTC+14
    // 2026-09-09T12:00:00Z is 2026-09-10 02:00 local — "today" is the 10th.
    const now = new Date('2026-09-09T12:00:00Z')
    const today = toLocalDateString(now)
    expect(today).toBe('2026-09-10')

    // Board: a task due exactly today is not overdue.
    expect(isOverdue({ due_date: today, state: 'todo' }, today)).toBe(false)
    // Milestones (and Gantt, which draws the same submissionWindow): a
    // milestone due exactly today has not passed.
    const window = submissionWindow(ms(today), now)
    expect(window.kind === 'dated' && window.passed).toBe(false)
    // Now: a milestone due exactly today is still the "upcoming" deadline,
    // not one that was filtered out as already gone.
    expect(nextDeadline([ms(today)], now).kind).toBe('due')
  })

  it('agrees a deadline of yesterday has passed everywhere, at that same offset', () => {
    vi.stubEnv('TZ', 'Pacific/Kiritimati')
    const now = new Date('2026-09-09T12:00:00Z') // local today: 2026-09-10
    const yesterday = '2026-09-09'

    expect(isOverdue({ due_date: yesterday, state: 'todo' }, toLocalDateString(now))).toBe(true)
    const window = submissionWindow(ms(yesterday), now)
    expect(window.kind === 'dated' && window.passed).toBe(true)
    expect(nextDeadline([ms(yesterday)], now).kind).toBe('tbc') // filtered out: nothing upcoming
  })
})

// The Gantt's new marks draw from the same "today" and the same overdue rule, so
// what a task looks like on the timeline can never disagree with the Board, Now
// or Priorities. Checked at the instants and zones where a day boundary bites:
// far east (UTC+14) and far west (UTC-11) near local midnight, and the two
// Copenhagen days the clocks change.
describe.each([
  ['UTC+14 near midnight', 'Pacific/Kiritimati', '2026-09-09T12:00:00Z', '2026-09-10'],
  ['UTC-11 near midnight', 'Pacific/Pago_Pago', '2026-09-10T10:30:00Z', '2026-09-09'],
  ['Copenhagen, spring-forward Sunday', 'Europe/Copenhagen', '2026-03-29T00:30:00Z', '2026-03-29'],
  ['Copenhagen, fall-back Sunday', 'Europe/Copenhagen', '2026-10-25T00:30:00Z', '2026-10-25'],
])('the Gantt agrees with every other screen: %s', (_name, zone, instant, expectedToday) => {
  it('reads the same local day, and the same overdue and passed answers', () => {
    vi.stubEnv('TZ', zone)
    const now = new Date(instant)
    const today = toLocalDateString(now)
    expect(today).toBe(expectedToday)
    const yesterday = new Date(`${today}T00:00:00Z`)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const before = yesterday.toISOString().slice(0, 10)

    for (const due of [before, today]) {
      const board = isOverdue({ due_date: due, state: 'todo' }, today)
      const gantt = taskMark({ starts_on: null, due_date: due, state: 'todo' }, today)
      expect('overdue' in gantt && gantt.overdue).toBe(board)
    }
    for (const due of [before, today]) {
      const window = submissionWindow(ms(due), now)
      expect(milestoneMarks({ opens_on: null, due_on: due }, today).passed).toBe(window.kind === 'dated' && window.passed)
    }
    // "Due today" is not late; "due yesterday" is: on every screen.
    expect(isOverdue({ due_date: today, state: 'todo' }, today)).toBe(false)
    expect(isOverdue({ due_date: before, state: 'todo' }, today)).toBe(true)
  })
})
