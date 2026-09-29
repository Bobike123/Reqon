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
// insert/delete landing mid-export — buildSeasonExport THROWS instead of
// returning a manifest that silently under-reports. Equal-count edits can
// still span pages undetected. There is no server-side snapshot
// mechanism in this schema, and building one has not been demonstrated as
// needed for a once-a-year handover file; if that changes, this is the place
// to revisit it.
// 4: archived work stays included; adds requirement junctions, Book source
// metadata, and clearly separated relevant global department history.
// 5: adds the season's department memberships (department_members, backend
// completion Phase 2).
export const EXPORT_VERSION = 5

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
  taskRequirements: unknown[]
  proposalRequirements: unknown[]
  proposalComments: unknown[]
  // Who worked in which department this season (organisational, grants nothing).
  departmentMembers: unknown[]
  meetings: unknown[]
  milestones: unknown[]
  milestoneSections: unknown[]
  specs: unknown[]
  // Every accepted and superseded observation, so a correction's old value and
  // its reason survive in the handover file.
  specMeasurements: unknown[]
  handoverNotes: unknown[]
  activity: unknown[]
  globalDepartmentActivity: unknown[]
  regulationDocument: unknown | null
  bookClauses: unknown[]
}

const CONSISTENCY_NOTE =
  'Best-effort paginated export, not a transactional snapshot. Every collection below was recounted ' +
  'independently in the database after fetching; the export would have failed rather than be produced ' +
  'if any count disagreed with the rows actually received. Recounts detect truncation and count-changing ' +
  'concurrent edits, but not equal-count replacements or edits; collections may therefore reflect different instants.'

// Only tables that actually carry a season_id. Typed as a union rather than
// `string` so a typo cannot compile.
type ScopedTable =
  | 'clause_status' | 'tasks' | 'task_proposals' | 'task_requirements' | 'proposal_requirements' | 'proposal_comments' | 'meetings'
  | 'milestones' | 'specs' | 'spec_measurements' | 'handover_notes' | 'activity' | 'department_members'

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
const KEY_COLUMNS: Record<ScopedTable, readonly string[]> = {
  clause_status: ['id'], tasks: ['id'], task_proposals: ['id'], meetings: ['id'],
  milestones: ['key'], specs: ['id'], spec_measurements: ['id'], handover_notes: ['id'], activity: ['id'],
  task_requirements: ['task_id', 'clause_key'],
  proposal_requirements: ['proposal_id', 'clause_key'],
  proposal_comments: ['id'],
  department_members: ['subteam_key', 'member_id'],
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
  keyColumns: readonly string[],
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>,
  count: PromiseLike<CountResult>,
): Promise<unknown[]> {
  const rows = await fetchAllRows<unknown>(
    what,
    (row) => JSON.stringify(keyColumns.map((column) => (row as Record<string, unknown>)[column])),
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
    const keyColumns = KEY_COLUMNS[table]
    return pagedAndVerified(
      `export ${table}`,
      keyColumns,
      (from, to) => {
        let query = supabase.from(table).select('*').eq('season_id', seasonId)
        for (const column of keyColumns) query = query.order(column)
        return query.range(from, to)
      },
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
    ['id'],
    (from, to) => supabase.from('members').select('id, full_name, role, status').order('id').range(from, to),
    supabase.from('members').select('*', { count: 'exact', head: true }),
  )
  const subteams = await pagedAndVerified(
    'export subteams',
    ['key'],
    (from, to) => supabase.from('subteams').select('*').order('key').range(from, to),
    supabase.from('subteams').select('*', { count: 'exact', head: true }),
  )

  const [
    clauseStatus, tasks, proposals, taskRequirements, proposalRequirements, proposalComments,
    meetings, milestones, specs, specMeasurements, handoverNotes, activity, departmentMembers,
  ] =
    await Promise.all([
      scoped('clause_status'), scoped('tasks'), scoped('task_proposals'),
      scoped('task_requirements'), scoped('proposal_requirements'), scoped('proposal_comments'), scoped('meetings'),
      scoped('milestones'), scoped('specs'), scoped('spec_measurements'), scoped('handover_notes'), scoped('activity'),
      scoped('department_members'),
    ])

  // milestone_sections has no season_id — it hangs off its milestone.
  const keys = (milestones as { key: string }[]).map((m) => m.key)
  const milestoneSections = keys.length
    ? await pagedAndVerified(
        'export milestone sections',
        ['id'],
        (from, to) => supabase.from('milestone_sections').select('*').in('milestone_key', keys).order('id').range(from, to),
        supabase.from('milestone_sections').select('*', { count: 'exact', head: true }).in('milestone_key', keys),
      )
    : []

  // Book provenance, not the PDF bytes: enough source metadata to resolve a
  // link and its printed/PDF page after handover. Clause body text and the
  // signed/private object contents are not copied into this JSON.
  const regsRef = typeof season.regs_ref === 'string' ? season.regs_ref : null
  const regulationDocuments = regsRef
    ? await pagedAndVerified(
        'export regulation document metadata',
        ['regs_ref'],
        (from, to) => supabase
          .from('regulation_documents')
          .select('regs_ref, edition, title, url, storage_path, page_offset, page_count, updated_at, updated_by')
          .eq('regs_ref', regsRef)
          .order('regs_ref')
          .range(from, to),
        supabase.from('regulation_documents').select('*', { count: 'exact', head: true }).eq('regs_ref', regsRef),
      )
    : []
  const bookClauses = regsRef
    ? await pagedAndVerified(
        'export Book clause metadata',
        ['clause_key'],
        (from, to) => supabase
          .from('clauses')
          .select('clause_key, printed_ref, regs_ref, source_page, subteam_key, milestone_key')
          .eq('regs_ref', regsRef)
          .order('clause_key')
          .range(from, to),
        supabase.from('clauses').select('*', { count: 'exact', head: true }).eq('regs_ref', regsRef),
      )
    : []

  // Department rows and their lifecycle are global. Export only the global
  // events for departments this season actually references, and keep them in
  // a separate collection so nobody mistakes them for season-owned events.
  const relevantDepartments = new Set<string>()
  for (const row of [...tasks, ...proposals, ...specs, ...handoverNotes, ...bookClauses, ...departmentMembers] as Record<string, unknown>[]) {
    if (typeof row.subteam_key === 'string') relevantDepartments.add(row.subteam_key)
  }
  const departmentKeys = [...relevantDepartments].sort()
  const globalDepartmentActivity = departmentKeys.length
    ? await pagedAndVerified(
        'export relevant global department history',
        ['id'],
        (from, to) => supabase
          .from('activity')
          .select('*')
          .is('season_id', null)
          .eq('entity', 'department')
          .in('entity_id', departmentKeys)
          .order('id')
          .range(from, to),
        supabase
          .from('activity')
          .select('*', { count: 'exact', head: true })
          .is('season_id', null)
          .eq('entity', 'department')
          .in('entity_id', departmentKeys),
      )
    : []

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
      taskRequirements: taskRequirements.length,
      proposalRequirements: proposalRequirements.length,
      proposalComments: proposalComments.length,
      departmentMembers: departmentMembers.length,
      meetings: meetings.length,
      milestones: milestones.length,
      milestoneSections: milestoneSections.length,
      specs: specs.length,
      specMeasurements: specMeasurements.length,
      handoverNotes: handoverNotes.length,
      activity: activity.length,
      globalDepartmentActivity: globalDepartmentActivity.length,
      regulationDocument: regulationDocuments.length,
      bookClauses: bookClauses.length,
    },
    members, subteams, clauseStatus, tasks, proposals, taskRequirements, proposalRequirements, proposalComments, departmentMembers, meetings,
    milestones, milestoneSections, specs, specMeasurements, handoverNotes, activity,
    globalDepartmentActivity, regulationDocument: regulationDocuments[0] ?? null, bookClauses,
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
