import type { Database } from '../lib/database.types.ts'

// The activity domain's own type alias, kept near the other small domain
// modules' types.ts (tasks/, specs/, book/) so a pure presentation module
// (presentation.ts) never has to import a data hook file just to name this
// row. data/useActivityHistory.ts re-exports it for its own consumers.
export type ActivityRow = Database['public']['Tables']['activity']['Row']
