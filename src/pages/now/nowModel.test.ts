import { describe, expect, it } from 'vitest'
import type { Milestone } from '../../data/useMilestones.ts'
import type { Attention, SubteamProgress } from '../../metrics/types.ts'
import type { Proposal } from '../../data/useProposals.ts'
import {
  attentionFor,
  blockedCount,
  departmentOverview,
  liveObligations,
  myOpenTasks,
  upcomingDeadlines,
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
  return { id: 'x', season_id: 's', title: 't', state, archived_at: null } as unknown as Proposal
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
  it('counts proposals awaiting a decision: suggested and under review', () => {
    expect(openProposalsCount([proposal('open'), proposal('open'), proposal('agenda'), proposal('decided'), proposal('parked')])).toBe(3)
  })
  it('never counts an archived proposal, whatever its stage', () => {
    const archived = { ...proposal('open'), archived_at: '2026-09-01T00:00:00Z' }
    expect(openProposalsCount([archived, proposal('open')])).toBe(1)
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

describe('department overview (Now)', () => {
  const dept = (key: string, over: Record<string, unknown> = {}) =>
    ({ key, name: key, is_parked: false, lead_id: null, sort_order: 0, archived_at: null, ...over }) as never
  const t = (id: string, subteam_key: string, state: string, over: Record<string, unknown> = {}) =>
    ({ id, subteam_key, state, archived_at: null, due_date: null, owner_id: null, ...over }) as never

  it('keeps work completion and requirement compliance as two separate measures, and leaves archived departments out', () => {
    const rows = departmentOverview(
      [dept('B', { sort_order: 2 }), dept('A', { sort_order: 1, lead_id: 'm1' }), dept('OLD', { archived_at: '2026-01-01T00:00:00Z' })],
      [t('1', 'A', 'done'), t('2', 'A', 'todo'), t('3', 'A', 'done', { archived_at: '2026-08-01T00:00:00Z' }), t('4', 'OLD', 'done')],
      [t('2', 'A', 'todo', { due_date: '2026-09-01' }), t('5', 'A', 'blocked')],
      [sub('A', 10, 4, false, 1)],
      '2026-09-09',
    )
    expect(rows.map((r) => r.key)).toEqual(['A', 'B'])
    const a = rows[0]
    expect(a.hasHead).toBe(true)
    // Archived-but-done work still counts as done.
    expect(a.work).toMatchObject({ done: 2, total: 3 })
    expect(a.open).toEqual({ todo: 1, wip: 0, blocked: 1 })
    expect(a.overdue).toBe(1)
    expect(a.requirements).toEqual({ resolved: 4, duties: 10, blockedRules: 1 })
    // No compliance row: "not available", never zero.
    expect(rows[1].requirements).toBeNull()
    expect(rows[1].hasHead).toBe(false)
  })
})

describe('Now action lists', () => {
  const t = (id: string, over: Record<string, unknown>) => ({ id, owner_id: null, due_date: null, state: 'todo', archived_at: null, ...over }) as never

  it('lists deadlines from today up to N days ahead, soonest first, without overdue, finished or archived work', () => {
    const list = upcomingDeadlines(
      [
        t('late', { due_date: '2026-09-08' }),
        t('today', { due_date: '2026-09-09' }),
        t('soon', { due_date: '2026-09-12' }),
        t('far', { due_date: '2026-09-30' }),
        t('done', { due_date: '2026-09-10', state: 'done' }),
        t('arch', { due_date: '2026-09-10', archived_at: '2026-09-01T00:00:00Z' }),
      ],
      '2026-09-09',
      7,
    ) as { id: string }[]
    expect(list.map((x) => x.id)).toEqual(['today', 'soon'])
  })

  it("lists the viewer's own open work, dated first and undated last, and nothing when signed out", () => {
    const tasks = [t('b', { owner_id: 'me', due_date: '2026-10-01' }), t('c', { owner_id: 'me' }), t('a', { owner_id: 'me', due_date: '2026-09-01' }), t('x', { owner_id: 'other' }), t('d', { owner_id: 'me', state: 'cancelled' })]
    expect((myOpenTasks(tasks, 'me') as { id: string }[]).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(myOpenTasks(tasks, null)).toEqual([])
  })

  it('picks attention rows by the reason the SQL gave', () => {
    expect(attentionFor([att('overdue'), att('blocked'), att('overdue')], 'overdue')).toHaveLength(2)
  })
})
