import { describe, expect, it } from 'vitest'
import {
  ALL_DEPARTMENTS,
  DEFAULT_FILTER,
  departmentChoices,
  describeFilter,
  filterProposals,
  isHistory,
  scopeCounts,
  type ProposalFilter,
} from './filters.ts'
import type { Proposal } from './types.ts'

function p(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id, season_id: 's', title: id, context: null, state: 'open', owner_id: null, decision: null, decided_at: null,
    meeting_id: null, starred: false, raised_by: 'me', raised_on: '2026-01-01', updated_at: '', subteam_key: 'AERO',
    due_date: '2026-12-01', priority: 'normal', milestone_key: 'MS1', outcome: null, archived_at: null,
    archived_by: null, archive_reason: null, legacy_incomplete: false,
    approved_as: null, approved_at: null, approved_by: null, approved_digest: null, approved_revision: null, revision: 1, ...over,
  }
}

const rows = [
  p('mine-aero'),
  p('theirs-aero', { raised_by: 'other' }),
  p('mine-body', { subteam_key: 'BODY' }),
  p('owned-by-me-not-mine', { raised_by: 'other', owner_id: 'me', subteam_key: 'BODY' }),
  p('parked', { state: 'parked' }),
  p('rejected', { state: 'decided', outcome: 'rejected', archived_at: '2026-09-01' }),
  p('approved', { state: 'decided', outcome: 'approved', archived_at: '2026-09-02' }),
  p('old-decided', { state: 'decided', subteam_key: 'GONE' }),
]
const f = (over: Partial<ProposalFilter> = {}): ProposalFilter => ({ ...DEFAULT_FILTER, ...over })
const ids = (list: Proposal[]) => list.map((x) => x.id).sort()

describe('queue versus history', () => {
  it('keeps parked work in the queue and puts rejected, approved and decided work in history', () => {
    expect(ids(filterProposals(rows, f(), 'me'))).toEqual(['mine-aero', 'mine-body', 'owned-by-me-not-mine', 'parked', 'theirs-aero'])
    expect(ids(filterProposals(rows, f({ view: 'history' }), 'me'))).toEqual(['approved', 'old-decided', 'rejected'])
    expect(isHistory(rows[5])).toBe(true)
    expect(isHistory(rows[4])).toBe(false)
  })
})

describe('scope x department', () => {
  it('"My proposals" means authored by the viewer, not proposed to them', () => {
    const mine = filterProposals(rows, f({ scope: 'mine' }), 'me')
    expect(ids(mine)).toEqual(['mine-aero', 'mine-body', 'parked'])
    expect(mine.map((x) => x.id)).not.toContain('owned-by-me-not-mine')
  })

  it.each([
    ['all', ALL_DEPARTMENTS, ['mine-aero', 'mine-body', 'owned-by-me-not-mine', 'parked', 'theirs-aero']],
    ['all', 'AERO', ['mine-aero', 'parked', 'theirs-aero']],
    ['all', 'BODY', ['mine-body', 'owned-by-me-not-mine']],
    ['mine', ALL_DEPARTMENTS, ['mine-aero', 'mine-body', 'parked']],
    ['mine', 'AERO', ['mine-aero', 'parked']],
    ['mine', 'BODY', ['mine-body']],
  ] as const)('%s + %s', (scope, department, expected) => {
    expect(ids(filterProposals(rows, f({ scope, department }), 'me'))).toEqual([...expected])
  })

  it('shows nothing for "mine" when nobody is signed in', () => {
    expect(filterProposals(rows, f({ scope: 'mine' }), null)).toEqual([])
  })

  it('counts each scope under the current department and view', () => {
    expect(scopeCounts(rows, f({ department: 'BODY' }), 'me')).toEqual({ all: 2, mine: 1 })
  })
})

describe('department choices', () => {
  const departments = [
    { key: 'AERO', name: 'Aerodynamics', archived_at: null },
    { key: 'BODY', name: 'Bodywork', archived_at: null },
    { key: 'GONE', name: 'Retired dept', archived_at: '2026-01-01' },
    { key: 'UNUSED', name: 'Old unused', archived_at: '2026-01-01' },
  ]
  it('offers only active departments in the queue', () => {
    expect(departmentChoices(departments, rows, 'queue').map((d) => d.key)).toEqual(['AERO', 'BODY'])
  })
  it('adds archived departments that history still refers to, marked as archived', () => {
    const choices = departmentChoices(departments, rows, 'history')
    expect(choices.map((d) => d.key)).toEqual(['AERO', 'BODY', 'GONE'])
    expect(choices[2].label).toBe('Retired dept (archived)')
  })
})

describe('describeFilter', () => {
  it('names the current filter in words', () => {
    expect(describeFilter(f({ scope: 'mine', department: 'AERO' }), 'Aerodynamics')).toBe('My proposals · Aerodynamics')
    expect(describeFilter(f(), null)).toBe('All proposals · All departments')
  })
})
