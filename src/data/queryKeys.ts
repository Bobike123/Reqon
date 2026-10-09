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
  // Where each regulations edition's document lives, one entry per edition
  // (regs_ref). Reference data, not season-scoped: a season only names its edition.
  regulationDocument: (regsRef: string | null | undefined) => ['regulation_document', regsRef ?? 'unknown'] as const,
  // A short-lived link to a file in the private bucket. Kept apart from the
  // document row so a refresh of the link never touches the configuration.
  bookFile: (regsRef: string, path: string) => ['book_file', regsRef, path] as const,
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
  proposalComments: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'proposal_comments'] as const,
  // Which requirements each proposal cites (proposal_requirements), by season.
  proposalRequirements: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'proposal_requirements'] as const,
  clauseStatus: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'clause_status'] as const,
  // Under the clause_status prefix on purpose: every status change or realtime
  // event that refreshes clause_status refreshes the chapter progress with it.
  bookProgress: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'clause_status', 'v_book_progress'] as const,
  milestones: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'milestones'] as const,
  milestoneSections: (seasonId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'milestone_sections'] as const,
  specVerdicts: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'spec_verdicts'] as const,
  // Measurement history. `specMeasurementsAll` is the prefix of every spec's
  // history, so one invalidation (a realtime event, a backdated save) refreshes
  // whichever histories are open without knowing which spec changed.
  specMeasurementsAll: (seasonId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'spec_measurements'] as const,
  specMeasurements: (seasonId: string | undefined, specId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'spec_measurements', specId ?? 'unknown'] as const,
  // Readable audit history. `activityAll` is the season prefix invalidated by
  // realtime parent/link events; one open entity history sits below it.
  activityAll: (seasonId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'activity'] as const,
  activity: (seasonId: string | undefined, entity: string, entityId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'activity', entity, entityId ?? 'unknown'] as const,
  meetings: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'meetings'] as const,
  handoverNotes: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'handover_notes'] as const,
  financeEntries: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'finance_entries'] as const,
  subteamProgress: (seasonId: string | undefined) =>
    ['season', seasonId ?? 'unknown', 'v_subteam_progress'] as const,
  attention: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'attention'] as const,
  // Everything the archive screen reads. One prefix, so an archive or restore
  // (from a mutation or a realtime event) refreshes all of it with one call.
  archive: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'archive'] as const,
  archivedTasks: (seasonId: string | undefined, params: unknown) =>
    ['season', seasonId ?? 'unknown', 'archive', 'tasks', params] as const,
  proposalHistory: (seasonId: string | undefined, params: unknown) =>
    ['season', seasonId ?? 'unknown', 'archive', 'proposals', params] as const,
  // Small lookups by id, kept apart from the active lists so a promoted
  // proposal's title (or its task) stays resolvable however the lists are scoped.
  sourceProposals: (seasonId: string | undefined, ids: readonly string[]) =>
    ['season', seasonId ?? 'unknown', 'archive', 'source_proposals', ids] as const,
  tasksBySource: (seasonId: string | undefined, ids: readonly string[]) =>
    ['season', seasonId ?? 'unknown', 'archive', 'tasks_by_source', ids] as const,
  taskRequirements: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'task_requirements'] as const,
  taskDependencies: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'task_dependencies'] as const,
  progressTasks: (seasonId: string | undefined) => ['season', seasonId ?? 'unknown', 'progress_tasks'] as const,

  // Task attachments (docs/ultraplan Phase 3). Keyed by task, not season: a task id is unique across
  // seasons, and the panel that reads them is always about one task.
  taskAttachments: (taskId: string) => ['task_attachments', taskId] as const,
  // Every file of the season, for the Files page (prefix 'season_attachments' drops them all).
  seasonAttachments: (seasonId: string | undefined) => ['season_attachments', seasonId ?? 'unknown'] as const,
  seasonAttachmentsAll: ['season_attachments'] as const,
  // Short-lived signed links, kept apart from the rows so refreshing a link never refetches the list.
  attachmentUrls: (variant: 'thumb' | 'original', ids: readonly string[]) => ['attachment_urls', variant, ids] as const,
  attachmentUsage: ['attachment_usage'] as const,
  // What the backup workflow recorded (docs/ultraplan Phase 4); Board only, not season-scoped.
  backupRuns: ['backup_runs'] as const,
} as const
