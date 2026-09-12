import { supabase } from '../lib/supabase.ts'
import { unwrap } from './errors.ts'

// One JSON file containing everything the team recorded this season.
//
// What is deliberately NOT in here: anything from `auth`. Members are exported
// as the roster rows they are — names, roles, subteam leads — with no email,
// no password hash, no session and no key. The file is meant to be handed to
// next year's team, so it must be safe to email.
export const EXPORT_VERSION = 1

export type SeasonExport = {
  exportVersion: number
  exportedAt: string
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

// Only tables that actually carry a season_id. Typed as a union rather than
// `string` so a typo cannot compile.
type ScopedTable =
  | 'clause_status' | 'tasks' | 'task_proposals' | 'meetings'
  | 'milestones' | 'specs' | 'handover_notes' | 'activity'

export async function buildSeasonExport(seasonId: string): Promise<SeasonExport> {
  const scoped = async (table: ScopedTable) =>
    unwrap<unknown[]>(
      `export ${table}`,
      await supabase.from(table).select('*').eq('season_id', seasonId),
    )

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
  const members = unwrap<unknown[]>(
    'export members',
    await supabase.from('members').select('id, full_name, role, status'),
  )
  const subteams = unwrap<unknown[]>(
    'export subteams',
    await supabase.from('subteams').select('*'),
  )

  const [clauseStatus, tasks, proposals, meetings, milestones, specs, handoverNotes, activity] =
    await Promise.all([
      scoped('clause_status'), scoped('tasks'), scoped('task_proposals'), scoped('meetings'),
      scoped('milestones'), scoped('specs'), scoped('handover_notes'), scoped('activity'),
    ])

  // milestone_sections has no season_id — it hangs off its milestone.
  const keys = (milestones as { key: string }[]).map((m) => m.key)
  const milestoneSections = keys.length
    ? unwrap<unknown[]>(
        'export milestone sections',
        await supabase.from('milestone_sections').select('*').in('milestone_key', keys),
      )
    : []

  // The regulations book is NOT exported: it is 1,146 rows of reference data
  // that belong to the edition, not to the team, and re-importing it is a
  // separate documented step.
  return {
    exportVersion: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
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
