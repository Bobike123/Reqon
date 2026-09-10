import type { UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { unwrap } from './errors.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type SubteamProgress = Database['public']['Views']['v_subteam_progress']['Row']
export type Attention = Database['public']['Views']['v_attention']['Row']

// Progress per subsystem, straight from the view. The counting rules — what
// "resolved" means, which clauses are duties — live in SQL (see
// docs/now-metrics.sql §7). React only draws the bar.
export function useSubteamProgress() {
  return useSeasonScopedQuery<SubteamProgress[]>(
    'v_subteam_progress',
    async (seasonId) =>
      unwrap(
        'load subteam progress',
        await supabase
          .from('v_subteam_progress')
          .select('*')
          .eq('season_id', seasonId)
          .order('duties', { ascending: false }),
      ),
  ) as UseQueryResult<SubteamProgress[], Error> & { seasonId: string | undefined }
}

// The attention list. `reason` (blocked / score-killer / penalty / overdue /
// starred) is computed by the view — never re-derived here. See
// docs/now-metrics.sql, final block.
export function useAttention() {
  return useSeasonScopedQuery<Attention[]>('v_attention', async (seasonId) =>
    unwrap(
      'load priorities',
      await supabase.from('v_attention').select('*').eq('season_id', seasonId),
    ),
  ) as UseQueryResult<Attention[], Error> & { seasonId: string | undefined }
}
