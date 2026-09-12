import { describe, expect, it } from 'vitest'
import type { Milestone } from '../../data/useMilestones.ts'
import type { Attention, SubteamProgress } from '../../data/useNowMetrics.ts'
import type { Proposal } from '../../data/useProposals.ts'
import {
  blockedCount,
  liveObligations,
  ms1Points,
  nextDeadline,
  openProposalsCount,
  overdueCount,
  percent,
} from './nowModel.ts'

const TODAY = new Date('2026-09-09T12:00:00Z')

function ms(key: string, due: string | null, points: number): Milestone {
  return { key, season_id: 's', ordinal: 1, name: key, aim: null, article_ref: null,
    opens_on: null, due_on: due, max_points: points, is_blocking: false, notes: null } as Milestone
}
function sub(key: string, duties: number, resolved: number, parked = false, blocked = 0): SubteamProgress {
  return { key, name: key, book_section: 'B', is_parked: parked, lead_id: null, season_id: 's',
    duties, resolved, in_progress: 0, blocked, total_rules: duties } as SubteamProgress
}
function att(reason: string): Attention {
  return { kind: 'clause', ref: 'X', title: 't', owner_id: null, season_id: 's',
    reason, starred: false, clause_key: 'X' } as Attention
}
function proposal(state: string): Proposal {
  return { id: 'x', season_id: 's', title: 't', state } as unknown as Proposal
}

describe('next deadline', () => {
  it('picks the earliest future milestone and counts the days', () => {
    const d = nextDeadline([ms('MS1-2', '2027-02-28', 100), ms('MS1-1', '2026-11-30', 75)], TODAY)
    expect(d.kind).toBe('due')
    if (d.kind === 'due') {
      expect(d.milestoneKey).toBe('MS1-1')
      expect(d.days).toBe(82)
    }
  })

  it('ignores milestones whose date has passed', () => {
    const d = nextDeadline([ms('OLD', '2026-01-01', 10), ms('MS1-1', '2026-11-30', 75)], TODAY)
    expect(d.kind === 'due' && d.milestoneKey).toBe('MS1-1')
  })

  it('renders TBC rather than inventing a date when due_on is null', () => {
    // MS1-7 happens at the Final Event and has no published window.
    expect(nextDeadline([ms('MS1-7', null, 60)], TODAY).kind).toBe('tbc')
  })

  it('renders TBC when there are no milestones at all', () => {
    expect(nextDeadline([], TODAY).kind).toBe('tbc')
  })
})

describe('live obligations', () => {
  it('sums duties and resolved, excluding parked subteams', () => {
    const out = liveObligations([sub('DOCS', 129, 5), sub('RACEOP', 58, 3, true)])
    expect(out).toEqual({ resolved: 5, total: 129 })
  })

  it('is zero/zero with no data, and does not divide by zero', () => {
    expect(liveObligations([])).toEqual({ resolved: 0, total: 0 })
    expect(percent(0, 0)).toBe(0)
  })
})

describe('MS1 points', () => {
  it('sums the MS1 milestones and excludes the Rider Eligibility Declaration', () => {
    const points = ms1Points([
      ms('MS1-1', '2026-11-30', 75), ms('MS1-2', '2027-02-28', 100),
      ms('MS1-3', '2027-04-30', 150), ms('MS1-4', '2027-05-31', 60),
      ms('MS1-5', '2027-05-31', 75), ms('MS1-6', '2027-06-30', 80),
      ms('MS1-7', null, 60), ms('RED', '2027-08-31', 0),
    ])
    expect(points).toBe(600)
  })

  it('reads the number from the data rather than hard-coding 600', () => {
    // A future edition with different points must show its own total.
    expect(ms1Points([ms('MS1-1', null, 10), ms('MS1-2', null, 15)])).toBe(25)
  })

  it('is zero when no milestones exist', () => {
    expect(ms1Points([])).toBe(0)
  })
})

describe('counts from v_attention', () => {
  it('counts overdue and blocked by the view\'s own reason column', () => {
    const rows = [att('overdue'), att('blocked'), att('blocked'), att('starred'), att('penalty')]
    expect(overdueCount(rows)).toBe(1)
    expect(blockedCount(rows)).toBe(2)
  })

  it('is zero on an empty list', () => {
    expect(overdueCount([])).toBe(0)
    expect(blockedCount([])).toBe(0)
  })
})

describe('open proposals', () => {
  it('counts only proposals still in the open state', () => {
    expect(openProposalsCount([proposal('open'), proposal('open'), proposal('agenda'), proposal('decided')])).toBe(2)
  })
  it('is zero on an empty list', () => {
    expect(openProposalsCount([])).toBe(0)
  })
})

describe('percent', () => {
  it('rounds and guards against an empty denominator', () => {
    expect(percent(2, 433)).toBe(0)
    expect(percent(217, 433)).toBe(50)
    expect(percent(5, 0)).toBe(0)
  })
})
