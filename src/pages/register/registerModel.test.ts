import { describe, expect, it } from 'vitest'
import type { Clause } from '../../data/useClauses.ts'
import type { ClauseStatus } from '../../data/useClauseStatus.ts'
import {
  applyFilters,
  buildRows,
  criticalityBadge,
  DEFAULT_FILTERS,
  formatSpec,
  groupRows,
  readSpecs,
  type GroupContext,
  type SubteamInfo,
} from './registerModel.ts'

function clause(over: Partial<Clause> & { clause_key: string }): Clause {
  return {
    clause_key: over.clause_key,
    printed_ref: over.printed_ref ?? over.clause_key,
    section: over.section ?? 'B',
    article: over.article ?? 1,
    article_title: over.article_title ?? null,
    group_title: over.group_title ?? null,
    subteam_key: over.subteam_key ?? 'GEOM',
    body: over.body ?? 'Some rule text.',
    obligation: over.obligation ?? 'requirement',
    criticality: over.criticality ?? 'required',
    phase: over.phase ?? 'design',
    milestone_key: over.milestone_key ?? null,
    is_team_duty: over.is_team_duty ?? true,
    specs: over.specs ?? null,
  } as Clause
}

function status(over: Partial<ClauseStatus> & { clause_key: string }): ClauseStatus {
  return {
    id: `st-${over.clause_key}`,
    season_id: 'season-a',
    clause_key: over.clause_key,
    state: over.state ?? 'open',
    owner_id: over.owner_id ?? null,
    evidence: over.evidence ?? null,
    starred: over.starred ?? false,
    updated_by: null,
    updated_at: '2026-01-01T00:00:00Z',
  } as ClauseStatus
}

const SUBTEAMS = new Map<string, SubteamInfo>([
  ['GEOM', { name: 'Design Envelope', isParked: false }],
  ['RACEOP', { name: 'Race Operations', isParked: true }],
  ['DOCS', { name: 'Documentation', isParked: false }],
])

const CTX: GroupContext = {
  subteams: SUBTEAMS,
  memberNames: new Map([['m1', 'Ada Rider'], ['m2', 'Bo Wrench']]),
}

// --- The duplicate printed_ref quirk ---------------------------------------

describe('duplicate printed references (MS2627 Rev.01 quirk)', () => {
  const clauses = [
    clause({ clause_key: 'F.5.2.3', printed_ref: 'F.5.2.3', body: 'First rule' }),
    clause({ clause_key: 'F.5.2.3#2', printed_ref: 'F.5.2.3', body: 'Second rule' }),
  ]

  it('keeps both rows, addressed independently by clause_key', () => {
    const rows = buildRows(clauses, [status({ clause_key: 'F.5.2.3#2', state: 'compliant' })], SUBTEAMS)
    expect(rows).toHaveLength(2)
    const first = rows.find((r) => r.clause.clause_key === 'F.5.2.3')
    const second = rows.find((r) => r.clause.clause_key === 'F.5.2.3#2')
    // Same printed reference, different identity, independent status.
    expect(first?.clause.printed_ref).toBe('F.5.2.3')
    expect(second?.clause.printed_ref).toBe('F.5.2.3')
    expect(first?.state).toBe('open')
    expect(second?.state).toBe('compliant')
  })

  it('does not merge them when grouping', () => {
    const rows = buildRows(clauses, [], SUBTEAMS)
    const groups = groupRows(rows, 'subsystem', CTX)
    expect(groups[0].rows).toHaveLength(2)
  })

  it('finds both when searching the printed reference', () => {
    const rows = buildRows(clauses, [], SUBTEAMS)
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'F.5.2.3' })).toHaveLength(2)
  })
})

// --- All six groupings ------------------------------------------------------

describe('the six groupings', () => {
  const clauses = [
    clause({ clause_key: 'B.1', subteam_key: 'GEOM', obligation: 'constraint', section: 'B', article: 1, milestone_key: 'MS1-4' }),
    clause({ clause_key: 'F.1', subteam_key: 'DOCS', obligation: 'deliverable', section: 'F', article: 13 }),
    clause({ clause_key: 'G.1', subteam_key: 'RACEOP', obligation: 'sporting', section: 'G', article: 2 }),
  ]
  const statuses = [
    status({ clause_key: 'B.1', state: 'compliant', owner_id: 'm1' }),
    status({ clause_key: 'F.1', state: 'wip' }),
  ]
  const rows = buildRows(clauses, statuses, SUBTEAMS)

  it('groups by subsystem, using the subteam name', () => {
    const groups = groupRows(rows, 'subsystem', CTX)
    expect(groups.map((g) => g.label).sort()).toEqual([
      'Design Envelope', 'Documentation', 'Race Operations',
    ])
  })

  it('groups by kind of work (obligation)', () => {
    const groups = groupRows(rows, 'kind', CTX)
    expect(groups.map((g) => g.key).sort()).toEqual(['constraint', 'deliverable', 'sporting'])
  })

  it('groups by milestone with a real bucket for untied rules', () => {
    const groups = groupRows(rows, 'milestone', CTX)
    expect(groups.map((g) => g.label)).toContain('MS1-4')
    expect(groups.map((g) => g.label)).toContain('Not tied to a milestone')
    expect(groups.find((g) => g.label === 'Not tied to a milestone')?.rows).toHaveLength(2)
  })

  it('groups by owner with an Unassigned bucket', () => {
    const groups = groupRows(rows, 'owner', CTX)
    const unassigned = groups.find((g) => g.key === 'unassigned')
    expect(unassigned?.rows).toHaveLength(2)
    expect(groups.find((g) => g.key === 'm1')?.label).toBe('Ada Rider')
  })

  it('groups by status, treating a missing row as open', () => {
    const groups = groupRows(rows, 'status', CTX)
    expect(groups.find((g) => g.key === 'open')?.rows).toHaveLength(1)   // G.1
    expect(groups.find((g) => g.key === 'compliant')?.rows).toHaveLength(1)
    expect(groups.find((g) => g.key === 'wip')?.rows).toHaveLength(1)
  })

  it('groups by book order, sorted by section then article', () => {
    const groups = groupRows(rows, 'book', CTX)
    expect(groups.map((g) => g.key)).toEqual(['B.1', 'F.13', 'G.2'])
  })

  it('puts every row in exactly one bucket, in every mode', () => {
    for (const mode of ['subsystem', 'kind', 'milestone', 'owner', 'status', 'book'] as const) {
      const total = groupRows(rows, mode, CTX).reduce((n, g) => n + g.rows.length, 0)
      expect(total, `grouping ${mode} lost or duplicated rows`).toBe(rows.length)
    }
  })
})

// --- Filters ----------------------------------------------------------------

describe('filters', () => {
  const clauses = [
    clause({ clause_key: 'D1', is_team_duty: true, obligation: 'constraint', body: 'fairing width limit' }),
    clause({ clause_key: 'D2', is_team_duty: false, obligation: 'info', body: 'definition of a team' }),
    clause({ clause_key: 'D3', is_team_duty: true, obligation: 'verification', body: 'brake test' }),
  ]
  const statuses = [
    status({ clause_key: 'D1', state: 'compliant', owner_id: 'm1' }),
    status({ clause_key: 'D3', state: 'blocked' }),
  ]
  const rows = buildRows(clauses, statuses, SUBTEAMS)

  it('defaults to team duties only', () => {
    expect(DEFAULT_FILTERS.teamDutiesOnly).toBe(true)
    const out = applyFilters(rows, DEFAULT_FILTERS)
    expect(out.map((r) => r.clause.clause_key)).toEqual(['D1', 'D3'])
  })

  it('shows the non-duty rules when the toggle is switched off', () => {
    const out = applyFilters(rows, { ...DEFAULT_FILTERS, teamDutiesOnly: false })
    expect(out).toHaveLength(3)
  })

  it('searches reference and body text', () => {
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'brake' })).toHaveLength(1)
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'D1' })).toHaveLength(1)
  })

  it('filters by obligation', () => {
    const out = applyFilters(rows, { ...DEFAULT_FILTERS, obligation: 'verification' })
    expect(out.map((r) => r.clause.clause_key)).toEqual(['D3'])
  })

  it('filters by owner, including an unassigned bucket', () => {
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, owner: 'm1' })).toHaveLength(1)
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, owner: 'unassigned' })).toHaveLength(1)
  })

  it('filters to unresolved only (compliant/verified/na count as resolved)', () => {
    const out = applyFilters(rows, { ...DEFAULT_FILTERS, unresolvedOnly: true })
    expect(out.map((r) => r.clause.clause_key)).toEqual(['D3'])
  })

  it('combines filters', () => {
    const out = applyFilters(rows, {
      ...DEFAULT_FILTERS,
      unresolvedOnly: true,
      obligation: 'verification',
      search: 'brake',
    })
    expect(out.map((r) => r.clause.clause_key)).toEqual(['D3'])
  })
})

// --- Parked and criticality presentation ------------------------------------

describe('parked (RACEOP) rules', () => {
  const clauses = [
    clause({ clause_key: 'G.9', subteam_key: 'RACEOP', body: 'pit lane speed' }),
    clause({ clause_key: 'B.9', subteam_key: 'GEOM' }),
  ]
  const rows = buildRows(clauses, [], SUBTEAMS)

  it('marks RACEOP rows as parked', () => {
    expect(rows.find((r) => r.clause.clause_key === 'G.9')?.isParked).toBe(true)
    expect(rows.find((r) => r.clause.clause_key === 'B.9')?.isParked).toBe(false)
  })

  it('does NOT remove parked rows from the default view', () => {
    expect(applyFilters(rows, DEFAULT_FILTERS)).toHaveLength(2)
  })

  it('still finds parked rows by explicit search', () => {
    const out = applyFilters(rows, { ...DEFAULT_FILTERS, search: 'pit lane' })
    expect(out).toHaveLength(1)
    expect(out[0].isParked).toBe(true)
  })
})

describe('criticality badges', () => {
  it('marks blocking as NC risk and penalty distinctly', () => {
    expect(criticalityBadge('blocking')?.label).toBe('NC RISK')
    expect(criticalityBadge('penalty')?.label).toBe('PENALTY')
    expect(criticalityBadge('blocking')?.className).not.toBe(criticalityBadge('penalty')?.className)
  })

  it('gives ordinary rules no badge', () => {
    expect(criticalityBadge('info')).toBeNull()
    expect(criticalityBadge('required')).toBeNull()
    expect(criticalityBadge('recommended')).toBeNull()
  })
})

describe('extracted numeric specs', () => {
  it('reads and formats them', () => {
    const specs = readSpecs([{ op: 'min', unit: 'mm', value: 450 }])
    expect(specs).toHaveLength(1)
    expect(formatSpec(specs[0])).toBe('≥ 450 mm')
    expect(formatSpec({ op: 'max', unit: 'minutes', value: 30 })).toBe('≤ 30 minutes')
  })

  it('tolerates rules with no specs', () => {
    expect(readSpecs(null)).toEqual([])
  })
})
