// Every cache key in the app, in one place. Two rules:
//
//  1. Season-scoped data puts the season id in the key, so switching season
//     cannot show the previous season's rows — they are simply a different
//     cache entry.
//  2. The season id sits high in the key, so invalidating
//     ['season', id] drops everything belonging to that season at once —
//     nothing here currently needs to (see useSetCurrentSeason), but a future
//     bulk operation, e.g. a season-delete, would.
//
// One named factory per entity, not a generic seasonScoped(id, 'entity
// string'). A typo in a free-form entity string is a silent cache-key
// mismatch that only shows up as "my mutation didn't seem to invalidate
// anything"; a typo in a factory name is a compile error.
export const queryKeys = {
  currentSeason: ['currentSeason'] as const,
  seasons: ['seasons'] as const,

  // Global reference data — the rulebook and the roster outlive any season.
  clauses: ['clauses'] as const,
  members: ['members'] as const,
  // Who holds which privileged role. Every role query sits under this prefix,
  // so one invalidation refreshes the roster's badges AND the signed-in
  // person's own permissions (AuthProvider) together.
  memberRoles: ['member_roles'] as const,
  subteams: ['subteams'] as const,
  // The club's default meeting agenda. One row, not season-scoped.
  meetingTemplate: ['meeting_template'] as const,

  // The season prefix itself. Rarely used directly — see rule 2 above — but
  // kept so a whole-season invalidation stays exactly this one call.
  season: (seasonId: string) => ['season', seasonId] as const,

  // Season-scoped entities. `seasonId` is `string | undefined` on purpose: a
  // hook that has not resolved the season yet still needs a stable key to
  // register a (disabled) query under, so unresolved reads share one
  // 'unknown' bucket rather than each inventing their own placeholder.
  tasks: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'tasks'] as const,
  proposals: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'task_proposals'] as const,
  clauseStatus: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'clause_status'] as const,
  milestones: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'milestones'] as const,
  milestoneSections: (seasonId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'milestone_sections'] as const,
  specVerdicts: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'spec_verdicts'] as const,
  meetings: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'meetings'] as const,
  handoverNotes: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'handover_notes'] as const,
  financeEntries: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'finance_entries'] as const,
  subteamProgress: (seasonId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'v_subteam_progress'] as const,
  attention: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'v_attention'] as const,
} as const
