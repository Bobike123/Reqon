// Every cache key in the app, in one place. Two rules:
//
//  1. Season-scoped data puts the season id in the key, so switching season
//     cannot show the previous season's rows — they are simply a different
//     cache entry.
//  2. The season id sits high in the key, so invalidating
//     ['season', id] drops everything belonging to that season at once.
export const queryKeys = {
  currentSeason: ['currentSeason'] as const,

  // Global reference data — the rulebook and the roster outlive any season.
  clauses: ['clauses'] as const,
  members: ['members'] as const,
  subteams: ['subteams'] as const,

  season: (seasonId: string) => ['season', seasonId] as const,
  seasonScoped: (seasonId: string, entity: string) =>
    ['season', seasonId, entity] as const,
} as const
