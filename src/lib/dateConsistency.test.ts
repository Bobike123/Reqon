import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Milestone } from '../data/useMilestones.ts'
import { isOverdue } from '../pages/board/boardModel.ts'
import { submissionWindow } from '../pages/milestones/milestoneModel.ts'
import { nextDeadline } from '../pages/now/nowModel.ts'
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
