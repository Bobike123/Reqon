import { beforeEach, describe, expect, it, vi } from 'vitest'

// Two invariants Phase 4 adds that nothing else in the suite covers directly:
// season isolation across EVERY exported collection at once (settings.test.tsx
// only spot-checks tasks/clauseStatus), and that a count disagreement between
// the paged fetch and an independent database count fails the export instead
// of silently under-reporting it.

type Row = Record<string, unknown>

let db: Record<string, Row[]>
// When set, overrides the count a table's { count: 'exact', head: true }
// query reports, independent of how many rows actually match — simulating a
// row that vanished (or a page that was dropped) between the fetch and the
// count, or vice versa.
let forcedCount: Record<string, number> | null = null
// When set, the count query for this table fails outright — a network blip
// asking "how many?", distinct from the fetch itself failing.
let countErrorFor: string | null = null

function makeBuilder(table: string) {
  const ctx: {
    filters: Record<string, unknown>
    inFilters: Record<string, unknown[]>
    selected: string | null
    orders: string[]
    single: boolean
    count?: string
    head?: boolean
    range?: [number, number]
  } = { filters: {}, inFilters: {}, selected: null, orders: [], single: false }
  const matches = (row: Row) =>
    Object.entries(ctx.filters).every(([k, v]) => row[k] === v) &&
    Object.entries(ctx.inFilters).every(([k, vs]) => vs.includes(row[k]))
  const run = () => {
    const hit = (db[table] ?? []).filter(matches).sort((a, b) => {
      for (const column of ctx.orders) {
        const left = String(a[column] ?? '')
        const right = String(b[column] ?? '')
        const compared = left.localeCompare(right)
        if (compared !== 0) return compared
      }
      return 0
    })
    if (ctx.count) {
      if (countErrorFor === table) {
        return { data: null, count: null, error: { message: 'connection lost', code: '08006' } }
      }
      const count = forcedCount?.[table] ?? hit.length
      return { data: ctx.head ? null : hit, count, error: null }
    }
    const paged = ctx.range ? hit.slice(ctx.range[0], ctx.range[1] + 1) : hit
    const selected = ctx.selected && ctx.selected !== '*'
      ? paged.map((row) => Object.fromEntries(ctx.selected!.split(',').map((column) => column.trim()).map((column) => [column, row[column]])))
      : paged
    return { data: ctx.single ? (selected[0] ?? null) : selected, error: null }
  }
  const b: Record<string, unknown> = {
    select: (cols: string = '*', opts?: { count?: string; head?: boolean }) => {
      ctx.selected = cols
      ctx.count = opts?.count
      ctx.head = opts?.head
      return b
    },
    eq: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    is: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    in: (c: string, vs: unknown[]) => { ctx.inFilters[c] = vs; return b },
    order: (c: string) => { ctx.orders.push(c); return b },
    range: (from: number, to: number) => { ctx.range = [from, to]; return b },
    single: () => { ctx.single = true; return b },
    then: (resolve: (v: unknown) => void) => { resolve(run()); return Promise.resolve() },
  }
  return b
}

const supabase = { from: (t: string) => makeBuilder(t) }
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))

const { buildSeasonExport, EXPORT_VERSION } = await import('./exportSeason.ts')

beforeEach(() => {
  forcedCount = null
  countErrorFor = null
  db = {
    seasons: [
      { id: 'sa', label: 'Season A', edition: null, regs_ref: 'rules-a' },
      { id: 'sb', label: 'Season B', edition: null, regs_ref: 'rules-b' },
    ],
    members: [{ id: 'm1', full_name: 'Ada Rider', role: 'Lead', status: 'active', phone: 'private', notes: 'private', skills: ['private'] }],
    subteams: [{ key: 'GEOM', name: 'Geometry' }],
    clause_status: [
      { id: 'cs-a1', season_id: 'sa', clause_key: 'B.1.1.1', state: 'compliant' },
      { id: 'cs-b1', season_id: 'sb', clause_key: 'B.1.1.1', state: 'open' },
    ],
    tasks: [
      { id: 't-a1', season_id: 'sa', title: 'A task', subteam_key: 'GEOM', archived_at: null },
      { id: 't-a2', season_id: 'sa', title: 'Archived A task', subteam_key: 'GEOM', archived_at: '2026-09-01T00:00:00Z' },
      { id: 't-b1', season_id: 'sb', title: 'B task' },
    ],
    task_proposals: [
      { id: 'p-a1', season_id: 'sa', title: 'A proposal', subteam_key: 'GEOM', archived_at: '2026-09-01T00:00:00Z' },
      { id: 'p-b1', season_id: 'sb', title: 'B proposal' },
    ],
    task_requirements: [
      { task_id: 't-a1', clause_key: 'A.1', season_id: 'sa' },
      { task_id: 't-b1', clause_key: 'B.1', season_id: 'sb' },
    ],
    proposal_requirements: [
      { proposal_id: 'p-a1', clause_key: 'A.1', season_id: 'sa' },
      { proposal_id: 'p-b1', clause_key: 'B.1', season_id: 'sb' },
    ],
    proposal_comments: [
      { id: 'pc-a1', proposal_id: 'p-a1', season_id: 'sa', author_id: 'm1', body: 'A discussion' },
      { id: 'pc-b1', proposal_id: 'p-b1', season_id: 'sb', author_id: 'm1', body: 'B discussion' },
    ],
    task_dependencies: [
      { task_id: 't-a1', depends_on_task_id: 't-a2', season_id: 'sa' },
      { task_id: 't-b1', depends_on_task_id: 't-b1', season_id: 'sb' },
    ],
    meetings: [
      { id: 'mt-a1', season_id: 'sa', title: 'A meeting' },
      { id: 'mt-b1', season_id: 'sb', title: 'B meeting' },
    ],
    milestones: [
      { key: 'MS1-1-a', season_id: 'sa', name: 'Team Plan A' },
      { key: 'MS1-1-b', season_id: 'sb', name: 'Team Plan B' },
    ],
    milestone_sections: [
      { id: 'sec-a1', milestone_key: 'MS1-1-a', name: 'Draft A' },
      { id: 'sec-b1', milestone_key: 'MS1-1-b', name: 'Draft B' },
    ],
    specs: [
      { id: 'sp-a1', season_id: 'sa', parameter: 'Fairing width', subteam_key: 'GEOM' },
      { id: 'sp-b1', season_id: 'sb', parameter: 'Fairing width' },
    ],
    spec_measurements: [
      { id: 'sm-a1', season_id: 'sa', spec_id: 'sp-a1', value_numeric: 612, invalidated_at: null },
      { id: 'sm-a2', season_id: 'sa', spec_id: 'sp-a1', value_numeric: 580, invalidated_at: '2026-09-02T10:00:00Z' },
      { id: 'sm-b1', season_id: 'sb', spec_id: 'sp-b1', value_numeric: 500, invalidated_at: null },
    ],
    spec_readiness: [
      { id: 'sr-a1', season_id: 'sa', spec_id: 'sp-a1', measurement_id: 'sm-a1', note: 'Checked on the scale', revoked_at: null },
      { id: 'sr-b1', season_id: 'sb', spec_id: 'sp-b1', measurement_id: 'sm-b1', note: 'B check', revoked_at: null },
    ],
    handover_notes: [
      { id: 'hn-a1', season_id: 'sa', subteam_key: 'GEOM', body: 'A note' },
      { id: 'hn-b1', season_id: 'sb', subteam_key: 'GEOM', body: 'B note' },
    ],
    activity: [
      { id: 1, season_id: 'sa', entity: 'task', entity_id: 't-a1', action: 'created', at: '2026-09-01' },
      { id: 2, season_id: 'sb', entity: 'task', entity_id: 't-b1', action: 'created', at: '2026-09-01' },
      { id: 3, season_id: null, entity: 'department', entity_id: 'GEOM', action: 'head_changed', at: '2026-09-01' },
      { id: 4, season_id: null, entity: 'department', entity_id: 'UNUSED', action: 'renamed', at: '2026-09-01' },
    ],
    regulation_documents: [
      { regs_ref: 'rules-a', edition: 'A', title: 'Rules A', storage_path: 'rules/a.pdf', page_offset: 2, page_count: 100, updated_at: '2026-01-01', updated_by: 'm1', pdf_bytes: 'never-export' },
      { regs_ref: 'rules-b', edition: 'B', title: 'Rules B' },
    ],
    clauses: [
      { clause_key: 'A.1', printed_ref: 'A.1', regs_ref: 'rules-a', source_page: 12, subteam_key: 'GEOM', milestone_key: 'MS1-1-a', body: 'not needed in handover metadata' },
      { clause_key: 'B.1', printed_ref: 'B.1', regs_ref: 'rules-b', source_page: 4, subteam_key: null, milestone_key: null },
    ],
  }
})

describe('season isolation', () => {
  it('never includes a Season B row in a Season A export, in any collection', async () => {
    const out = await buildSeasonExport('sa')

    expect(out.season).toMatchObject({ id: 'sa' })
    expect(out.tasks).toEqual([db.tasks[0], db.tasks[1]])
    expect(out.proposals).toEqual([db.task_proposals[0]])
    expect(out.taskRequirements).toEqual([db.task_requirements[0]])
    expect(out.proposalRequirements).toEqual([db.proposal_requirements[0]])
    expect(out.proposalComments).toEqual([db.proposal_comments[0]])
    expect(out.taskDependencies).toEqual([db.task_dependencies[0]])
    expect(out.meetings).toEqual([db.meetings[0]])
    expect(out.clauseStatus).toEqual([db.clause_status[0]])
    expect(out.milestones).toEqual([db.milestones[0]])
    expect(out.milestoneSections).toEqual([db.milestone_sections[0]])
    expect(out.specs).toEqual([db.specs[0]])
    // The whole history, invalidated observations included, so a correction's old
    // value and its reason survive in the handover file.
    expect(out.specMeasurements).toEqual([db.spec_measurements[0], db.spec_measurements[1]])
    expect(out.specReadiness).toEqual([db.spec_readiness[0]])
    expect(out.handoverNotes).toEqual([db.handover_notes[0]])
    expect(out.activity).toEqual([db.activity[0]])
    expect(out.globalDepartmentActivity).toEqual([db.activity[2]])
    expect(out.regulationDocument).toMatchObject({ regs_ref: 'rules-a', storage_path: 'rules/a.pdf' })
    expect(out.bookClauses).toEqual([{ clause_key: 'A.1', printed_ref: 'A.1', regs_ref: 'rules-a', source_page: 12, subteam_key: 'GEOM', milestone_key: 'MS1-1-a' }])

    // Belt and braces: no collection's JSON mentions a Season B id at all.
    const json = JSON.stringify(out)
    for (const bId of ['cs-b1', 't-b1', 'p-b1', 'pc-b1', 'mt-b1', 'MS1-1-b', 'sec-b1', 'sp-b1', 'sm-b1', 'sr-b1', 'hn-b1', 'rules-b']) {
      expect(json).not.toContain(bId)
    }
  })

  it('the reverse export is equally isolated', async () => {
    const out = await buildSeasonExport('sb')
    expect(out.tasks).toEqual([db.tasks[2]])
    expect(JSON.stringify(out)).not.toContain('t-a1')
  })
})

describe('independent count verification', () => {
  it('fails the export when the database count disagrees with the rows received', async () => {
    // The paged fetch finds the two Season A tasks (active and archived), but
    // the independent count query is told there are three.
    forcedCount = { tasks: 3 }
    await expect(buildSeasonExport('sa')).rejects.toThrow(/export tasks.*exported 2 row.*counts 3/s)
  })

  it('a clean export needs no such recovery and reports the real counts', async () => {
    const out = await buildSeasonExport('sa')
    expect(out.counts.tasks).toBe(2)
    expect(out.counts.clauseStatus).toBe(1)
    expect(out.counts.specMeasurements).toBe(2)
    expect(out.counts.taskRequirements).toBe(1)
    expect(out.counts.proposalComments).toBe(1)
    expect(out.counts.taskDependencies).toBe(1)
    expect(out.exportVersion).toBe(EXPORT_VERSION)
    expect(out.consistency).toContain('recounted')
    expect(out.consistency).toContain('not equal-count')
  })

  it('a mismatch on the measurement history fails too: a truncated history is not exported silently', async () => {
    forcedCount = { spec_measurements: 3 }
    await expect(buildSeasonExport('sa')).rejects.toThrow(/export spec_measurements.*exported 2 row.*counts 3/s)
  })

  it('exports only this season\'s department memberships, and counts them', async () => {
    db.department_members = [
      { season_id: 'sa', subteam_key: 'MECH', member_id: 'm1' },
      { season_id: 'sa', subteam_key: 'OPS', member_id: 'm1' },
      { season_id: 'sb', subteam_key: 'MECH', member_id: 'm1' },
    ]
    const out = await buildSeasonExport('sa')
    expect(out.exportVersion).toBe(EXPORT_VERSION)
    expect(out.departmentMembers).toHaveLength(2)
    expect(out.counts.departmentMembers).toBe(2)
  })

  it('a mismatch on members (a non-scoped collection) fails too', async () => {
    forcedCount = { members: 5 }
    await expect(buildSeasonExport('sa')).rejects.toThrow(/export members/)
  })

  it('surfaces a failed count query as its own failure, not a silent pass', async () => {
    countErrorFor = 'clause_status'
    await expect(buildSeasonExport('sa')).rejects.toThrow(/count export clause_status/)
  })

  it('pages past 1,000 composite-key links without truncating or deduplicating distinct clauses', async () => {
    db.task_requirements = Array.from({ length: 1_005 }, (_, index) => ({
      task_id: 't-a1', clause_key: `R.${String(index).padStart(4, '0')}`, season_id: 'sa',
    }))
    const out = await buildSeasonExport('sa')
    expect(out.taskRequirements).toHaveLength(1_005)
    expect(out.counts.taskRequirements).toBe(1_005)
  })

  it('keeps roster private fields and PDF/body content out of the handover JSON', async () => {
    const out = await buildSeasonExport('sa')
    const json = JSON.stringify(out)
    expect(json).not.toContain('private')
    expect(json).not.toContain('never-export')
    expect(json).not.toContain('not needed in handover metadata')
    expect(out.members[0]).toEqual({ id: 'm1', full_name: 'Ada Rider', role: 'Lead', status: 'active' })
  })
})

describe('progress block', () => {
  it('uses the shared definition: distinct, archived done counts, archived unfinished never done, cancelled left out', async () => {
    db.tasks = [
      { id: 'a', season_id: 'sa', state: 'done', subteam_key: 'GEOM', archived_at: null, milestone_key: 'MS1-1-a', section_id: null },
      { id: 'b', season_id: 'sa', state: 'done', subteam_key: 'GEOM', archived_at: '2026-09-01T00:00:00Z', milestone_key: 'MS1-1-a', section_id: null },
      { id: 'c', season_id: 'sa', state: 'wip', subteam_key: 'GEOM', archived_at: '2026-09-01T00:00:00Z', milestone_key: null, section_id: 'sec-a1' },
      { id: 'd', season_id: 'sa', state: 'cancelled', subteam_key: 'GEOM', archived_at: null, milestone_key: 'MS1-1-a', section_id: null },
      { id: 'e', season_id: 'sb', state: 'done', subteam_key: 'GEOM', archived_at: null, milestone_key: 'MS1-1-b', section_id: null },
    ]
    const out = await buildSeasonExport('sa')
    expect(out.progress.tasks).toMatchObject({ total: 3, done: 2, percent: 67, archivedDone: 1, archivedUnfinished: 1, cancelled: 1, openActive: 0 })
    expect(out.progress.byDepartment.GEOM).toMatchObject({ total: 3, done: 2 })
    // The section task is reached through its section, the keyed ones directly — each task once.
    expect(out.progress.byMilestone['MS1-1-a']).toMatchObject({ total: 3, done: 2 })
    expect(out.progress.byMilestone['MS1-1-b']).toBeUndefined()
    expect(out.progress.definition).toMatch(/never by averaging/)
  })

  it('says no linked work (null), not 0 %, for a milestone nothing points at', async () => {
    db.tasks = []
    const out = await buildSeasonExport('sa')
    expect(out.progress.tasks.percent).toBeNull()
    expect(out.progress.byMilestone['MS1-1-a'].percent).toBeNull()
  })
})
