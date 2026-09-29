import type { Database } from '../lib/database.types.ts'

// Rows the dashboard and Priorities read. Owned here, not by
// data/useNowMetrics.ts, so a pure calculation (pages/now/nowModel.ts) can
// name them without importing a React Query hook module — same reason as
// tasks/types.ts.
export type SubteamProgress = Database['public']['Views']['v_subteam_progress']['Row']
// ADR-0007: attention(p_season, p_today) replaced the v_attention view, so
// the client passes the reader's own "today" instead of the database
// disagreeing with it via an implicit current_date (bug D2).
type AttentionRow = Database['public']['Functions']['attention']['Returns'][number]
// A RETURNS TABLE column is generated as non-null whatever the SQL does; the
// query returns NULL for these on rows that have no owner, season or clause.
export type Attention = Omit<AttentionRow, 'owner_id' | 'season_id' | 'clause_key'> & {
  owner_id: string | null
  season_id: string | null
  clause_key: string | null
}
