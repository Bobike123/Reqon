import type { UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Attention, SubteamProgress } from '../metrics/types.ts'
import { useSeasonId } from '../season/context.ts'
import { fetchAllRows, unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type { Attention, SubteamProgress } from '../metrics/types.ts'

// Progress per subsystem, straight from the view. The counting rules — what
// "resolved" means, which clauses are duties — live in SQL (see
// docs/now-metrics.sql §7). React only draws the bar.
export function useSubteamProgressForSeason(seasonId: string | undefined): UseQueryResult<SubteamProgress[], Error> {
  return useSeasonScopedQuery<SubteamProgress[]>(queryKeys.subteamProgress(seasonId), seasonId, async (sid) =>
    unwrap(
      'load subteam progress',
      await supabase.from('v_subteam_progress').select('*').eq('season_id', sid).order('duties', { ascending: false }),
    ),
  )
}

export function useSubteamProgress(): UseQueryResult<SubteamProgress[], Error> {
  return useSubteamProgressForSeason(useSeasonId())
}

// The attention list. `reason` (blocked / score-killer / penalty / overdue /
// starred) is computed by the view — never re-derived here. See
// docs/now-metrics.sql, final block.
//
// v_attention is a UNION ALL of clause rows (unique by clause_key, kind =
// 'clause') and task rows (unique by ref = task id, kind = 'task'; clause_key
// null) — see supabase/migrations/20260103000000_attention_clause_key.sql. No
// single column is unique across the whole view, hence the composite key.
export function useAttentionForSeason(seasonId: string | undefined): UseQueryResult<Attention[], Error> {
  return useSeasonScopedQuery<Attention[]>(queryKeys.attention(seasonId), seasonId, (sid) =>
    fetchAllRows(
      'load priorities',
      (row) => `${row.kind}:${row.clause_key ?? row.ref}`,
      (from, to) =>
        supabase
          .from('v_attention')
          .select('*')
          .eq('season_id', sid)
          .order('kind')
          .order('clause_key', { nullsFirst: false })
          .order('ref')
          .range(from, to),
    ),
  )
}

export function useAttention(): UseQueryResult<Attention[], Error> {
  return useAttentionForSeason(useSeasonId())
}
