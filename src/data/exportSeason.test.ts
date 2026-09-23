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
    single: boolean
    count?: string
    head?: boolean
    range?: [number, number]
  } = { filters: {}, inFilters: {}, single: false }
  const matches = (row: Row) =>
    Object.entries(ctx.filters).every(([k, v]) => row[k] === v) &&
    Object.entries(ctx.inFilters).every(([k, vs]) => vs.includes(row[k]))
  const run = () => {
    const hit = (db[table] ?? []).filter(matches)
    if (ctx.count) {
      if (countErrorFor === table) {
        return { data: null, count: null, error: { message: 'connection lost', code: '08006' } }
      }
      const count = forcedCount?.[table] ?? hit.length
      return { data: ctx.head ? null : hit, count, error: null }
    }
    const paged = ctx.range ? hit.slice(ctx.range[0], ctx.range[1] + 1) : hit
    return { data: ctx.single ? (paged[0] ?? null) : paged, error: null }
  }
  const b: Record<string, unknown> = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      ctx.count = opts?.count
      ctx.head = opts?.head
      return b
    },
    eq: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    in: (c: string, vs: unknown[]) => { ctx.inFilters[c] = vs; return b },
    order: () => b,
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
      { id: 'sa', label: 'Season A', edition: null },
      { id: 'sb', label: 'Season B', edition: null },
    ],
    members: [{ id: 'm1', full_name: 'Ada Rider', role: 'Lead', status: 'active' }],
    subteams: [{ key: 'GEOM', name: 'Geometry' }],
    clause_status: [
      { id: 'cs-a1', season_id: 'sa', clause_key: 'B.1.1.1', state: 'compliant' },
      { id: 'cs-b1', season_id: 'sb', clause_key: 'B.1.1.1', state: 'open' },
    ],
    tasks: [
      { id: 't-a1', season_id: 'sa', title: 'A task' },
      { id: 't-b1', season_id: 'sb', title: 'B task' },
    ],
    task_proposals: [
      { id: 'p-a1', season_id: 'sa', title: 'A proposal' },
      { id: 'p-b1', season_id: 'sb', title: 'B proposal' },
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
      { id: 'sp-a1', season_id: 'sa', parameter: 'Fairing width' },
      { id: 'sp-b1', season_id: 'sb', parameter: 'Fairing width' },
    ],
    handover_notes: [
      { id: 'hn-a1', season_id: 'sa', subteam_key: 'GEOM', body: 'A note' },
      { id: 'hn-b1', season_id: 'sb', subteam_key: 'GEOM', body: 'B note' },
    ],
    activity: [
      { id: 1, season_id: 'sa', entity: 'task', entity_id: 't-a1', action: 'created', at: '2026-09-01' },
      { id: 2, season_id: 'sb', entity: 'task', entity_id: 't-b1', action: 'created', at: '2026-09-01' },
    ],
  }
})

describe('season isolation', () => {
  it('never includes a Season B row in a Season A export, in any collection', async () => {
    const out = await buildSeasonExport('sa')

    expect(out.season).toMatchObject({ id: 'sa' })
    expect(out.tasks).toEqual([db.tasks[0]])
    expect(out.proposals).toEqual([db.task_proposals[0]])
    expect(out.meetings).toEqual([db.meetings[0]])
    expect(out.clauseStatus).toEqual([db.clause_status[0]])
    expect(out.milestones).toEqual([db.milestones[0]])
    expect(out.milestoneSections).toEqual([db.milestone_sections[0]])
    expect(out.specs).toEqual([db.specs[0]])
    expect(out.handoverNotes).toEqual([db.handover_notes[0]])
    expect(out.activity).toEqual([db.activity[0]])

    // Belt and braces: no collection's JSON mentions a Season B id at all.
    const json = JSON.stringify(out)
    for (const bId of ['cs-b1', 't-b1', 'p-b1', 'mt-b1', 'MS1-1-b', 'sec-b1', 'sp-b1', 'hn-b1']) {
      expect(json).not.toContain(bId)
    }
  })

  it('the reverse export is equally isolated', async () => {
    const out = await buildSeasonExport('sb')
    expect(out.tasks).toEqual([db.tasks[1]])
    expect(JSON.stringify(out)).not.toContain('t-a1')
  })
})

describe('independent count verification', () => {
  it('fails the export when the database count disagrees with the rows received', async () => {
    // The paged fetch will only ever find the one Season A task that exists,
    // but the independent count query is told there are two.
    forcedCount = { tasks: 2 }
    await expect(buildSeasonExport('sa')).rejects.toThrow(/export tasks.*exported 1 row.*counts 2/s)
  })

  it('a clean export needs no such recovery and reports the real counts', async () => {
    const out = await buildSeasonExport('sa')
    expect(out.counts.tasks).toBe(1)
    expect(out.counts.clauseStatus).toBe(1)
    expect(out.exportVersion).toBe(EXPORT_VERSION)
    expect(out.consistency).toContain('recounted')
  })

  it('a mismatch on members (a non-scoped collection) fails too', async () => {
    forcedCount = { members: 5 }
    await expect(buildSeasonExport('sa')).rejects.toThrow(/export members/)
  })

  it('surfaces a failed count query as its own failure, not a silent pass', async () => {
    countErrorFor = 'clause_status'
    await expect(buildSeasonExport('sa')).rejects.toThrow(/count export clause_status/)
  })
})
