import type { PostgrestError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase.ts'
import { DataError } from '../core/errors.ts'
import { fetchAllRows, unwrap } from './errors.ts'

// One JSON file containing everything the team recorded this season.
//
// What is deliberately NOT in here: anything from `auth`. Members are exported
// as the roster rows they are — names, roles, subteam leads — with no email,
// no password hash, no session and no key. The file is meant to be handed to
// next year's team, so it must be safe to email.
//
// Consistency model (Phase 4 §4.5): this is a paginated, client-side,
// best-effort snapshot, not a transactional point-in-time backup. Each
// collection is fetched page by page and then independently recounted in the
// database; if the two disagree — truncation, a dropped page, or a genuine
// edit landing mid-export — buildSeasonExport THROWS instead of returning a
// manifest that silently under-reports. There is no server-side snapshot
// mechanism in this schema, and building one has not been demonstrated as
// needed for a once-a-year handover file; if that changes, this is the place
// to revisit it.
export const EXPORT_VERSION = 2

export type SeasonExport = {
  exportVersion: number
  exportedAt: string
  consistency: string
  season: Record<string, unknown>
  counts: Record<string, number>
  members: unknown[]
  subteams: unknown[]
  clauseStatus: unknown[]
  tasks: unknown[]
  proposals: unknown[]
  meetings: unknown[]
  milestones: unknown[]
  milestoneSections: unknown[]
  specs: unknown[]
  handoverNotes: unknown[]
  activity: unknown[]
}

const CONSISTENCY_NOTE =
  'Best-effort paginated export, not a transactional snapshot. Every collection below was recounted ' +
  'independently in the database after fetching; the export would have failed rather than be produced ' +
  'if any count disagreed with the rows actually received.'

// Only tables that actually carry a season_id. Typed as a union rather than
// `string` so a typo cannot compile.
type ScopedTable =
  | 'clause_status' | 'tasks' | 'task_proposals' | 'meetings'
  | 'milestones' | 'specs' | 'handover_notes' | 'activity'

// Retention (Phase 5 §5.6): `activity` rows are kept indefinitely — there is
// no scheduled deletion or archival job. The only thing that removes them is
// `activity.season_id references seasons(id) on delete cascade`
// (20260101000000): deleting a season deletes its audit trail with it, same
// as every other season-scoped table. This export is therefore a full,
// paginated (fetchAllRows), season-scoped, deterministically-ordered
// (ordered by `id`, its insertion order) copy of whatever the database still
// holds at export time — not a separate archive with its own retention
// clock. If a real retention window is ever wanted, it belongs in the
// database (a scheduled job), not invented here as a client-side filter.

// Every ScopedTable's own primary key, used both as the paging tie-breaker
// and as fetchAllRows's duplicate guard. `milestones` is keyed by `key`, not
// `id` — every other scoped table has a real `id` column.
const KEY_COLUMN: Record<ScopedTable, string> = {
  clause_status: 'id', tasks: 'id', task_proposals: 'id', meetings: 'id',
  milestones: 'key', specs: 'id', handover_notes: 'id', activity: 'id',
}

type CountResult = { count: number | null; error: PostgrestError | null }

async function verifiedCount(what: string, result: PromiseLike<CountResult>): Promise<number> {
  const { count, error } = await result
  if (error) throw new DataError(what, error)
  if (count === null) throw new DataError(`${what}: no count returned`, null)
  return count
}

// Fetches every row of `what`, then asks the database — independently, not by
// re-reading exportedArray.length — how many rows it now has under the same
// filter. A paginated fetch that silently truncated (a dropped page, hitting
// fetchAllRows's own safety ceiling, a row deleted from under a later page)
// would otherwise look identical to a complete one; this is what makes that
// detectable instead of trusted.
async function pagedAndVerified(
  what: string,
  keyColumn: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>,
  count: PromiseLike<CountResult>,
): Promise<unknown[]> {
  const rows = await fetchAllRows<unknown>(
    what,
    (row) => (row as Record<string, unknown>)[keyColumn] as string | number,
    page,
  )
  const expected = await verifiedCount(`count ${what}`, count)
  if (rows.length !== expected) {
    throw new DataError(
      `${what}: exported ${rows.length} row(s) but the database now counts ${expected}. ` +
        'The export did not complete cleanly and was not produced. Try exporting again.',
      null,
    )
  }
  return rows
}

export async function buildSeasonExport(seasonId: string): Promise<SeasonExport> {
  const scoped = (table: ScopedTable) => {
    const keyColumn = KEY_COLUMN[table]
    return pagedAndVerified(
      `export ${table}`,
      keyColumn,
      (from, to) => supabase.from(table).select('*').eq('season_id', seasonId).order(keyColumn).range(from, to),
      supabase.from(table).select('*', { count: 'exact', head: true }).eq('season_id', seasonId),
    )
  }

  const season = unwrap<Record<string, unknown>>(
    'export season',
    await supabase.from('seasons').select('*').eq('id', seasonId).single(),
  )

  // The roster and the subteam list are global, but a handover file is useless
  // without the names its owner ids point at.
  //
  // Named columns, not select('*'): this file gets emailed to next year's team,
  // and `members` also carries phone, notes, skills and study_year. Owner ids
  // only need a name to resolve, so that is all that leaves the database.
  const members = await pagedAndVerified(
    'export members',
    'id',
    (from, to) => supabase.from('members').select('id, full_name, role, status').order('id').range(from, to),
    supabase.from('members').select('*', { count: 'exact', head: true }),
  )
  const subteams = await pagedAndVerified(
    'export subteams',
    'key',
    (from, to) => supabase.from('subteams').select('*').order('key').range(from, to),
    supabase.from('subteams').select('*', { count: 'exact', head: true }),
  )

  const [clauseStatus, tasks, proposals, meetings, milestones, specs, handoverNotes, activity] =
    await Promise.all([
      scoped('clause_status'), scoped('tasks'), scoped('task_proposals'), scoped('meetings'),
      scoped('milestones'), scoped('specs'), scoped('handover_notes'), scoped('activity'),
    ])

  // milestone_sections has no season_id — it hangs off its milestone.
  const keys = (milestones as { key: string }[]).map((m) => m.key)
  const milestoneSections = keys.length
    ? await pagedAndVerified(
        'export milestone sections',
        'id',
        (from, to) => supabase.from('milestone_sections').select('*').in('milestone_key', keys).order('id').range(from, to),
        supabase.from('milestone_sections').select('*', { count: 'exact', head: true }).in('milestone_key', keys),
      )
    : []

  // The regulations book is NOT exported: it is 1,146 rows of reference data
  // that belong to the edition, not to the team, and re-importing it is a
  // separate documented step.
  return {
    exportVersion: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    consistency: CONSISTENCY_NOTE,
    season,
    counts: {
      members: members.length,
      subteams: subteams.length,
      clauseStatus: clauseStatus.length,
      tasks: tasks.length,
      proposals: proposals.length,
      meetings: meetings.length,
      milestones: milestones.length,
      milestoneSections: milestoneSections.length,
      specs: specs.length,
      handoverNotes: handoverNotes.length,
      activity: activity.length,
    },
    members, subteams, clauseStatus, tasks, proposals, meetings,
    milestones, milestoneSections, specs, handoverNotes, activity,
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
