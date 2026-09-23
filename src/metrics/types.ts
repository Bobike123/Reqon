import type { Database } from '../lib/database.types.ts'

// Rows of the two metric views the dashboard and Priorities read. Owned here,
// not by data/useNowMetrics.ts, so a pure calculation (pages/now/nowModel.ts)
// can name them without importing a React Query hook module — same reason as
// tasks/types.ts.
export type SubteamProgress = Database['public']['Views']['v_subteam_progress']['Row']
export type Attention = Database['public']['Views']['v_attention']['Row']
