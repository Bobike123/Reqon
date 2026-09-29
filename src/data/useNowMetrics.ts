import type { UseQueryResult } from '@tanstack/react-query'
import { todayIso } from '../lib/dates.ts'
import { supabase } from '../lib/supabase.ts'
import type { Attention, BookProgress, SubteamProgress } from '../metrics/types.ts'
import { useSeasonId } from '../season/context.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type { Attention, BookProgress, SubteamProgress } from '../metrics/types.ts'

// Progress per subsystem, straight from the view. The counting rules — what
// "resolved" means, which clauses are duties — live in SQL (see
// docs/now-metrics.sql §7). React only draws the bar.
export function useSubteamProgressForSeason(seasonId: string | undefined): UseQueryResult<SubteamProgress[], Error> {
  return useSeasonScopedQuery<SubteamProgress[]>(queryKeys.subteamProgress(seasonId), seasonId, async (sid) =>
    unwrap(
      'load department progress',
      await supabase.from('v_subteam_progress').select('*').eq('season_id', sid).order('duties', { ascending: false }),
    ),
  )
}

export function useSubteamProgress(): UseQueryResult<SubteamProgress[], Error> {
  return useSubteamProgressForSeason(useSeasonId())
}

// Requirement progress per book chapter and subchapter. What counts and what
// "resolved" means live in v_book_progress (20260125000500).
export function useBookProgress(): UseQueryResult<BookProgress[], Error> {
  const seasonId = useSeasonId()
  return useSeasonScopedQuery<BookProgress[]>(queryKeys.bookProgress(seasonId), seasonId, async (sid) =>
    unwrap('load requirements progress', await supabase.from('v_book_progress').select('*').eq('season_id', sid)),
  )
}

// The attention list. `reason` (blocked / score-killer / penalty / overdue /
// starred) is computed by attention(p_season, p_today) — never re-derived
// here. See docs/now-metrics.sql, final block.
//
// attention() is a UNION ALL of clause rows (unique by clause_key, kind =
// 'clause') and task rows (unique by ref = task id, kind = 'task'; clause_key
// null) — see 20260103000000_attention_clause_key.sql. No single column is
// unique across the whole result, hence the composite key.
//
// p_today is the READER's local day (todayIso()), not the database
// session's current_date — this is ADR-0007's fix for bug D2 (the Board's
// overdue check used to disagree with the SQL side of this exact list near
// local midnight, outside UTC).
export function useAttentionForSeason(seasonId: string | undefined): UseQueryResult<Attention[], Error> {
  return useSeasonScopedQuery<Attention[]>(queryKeys.attention(seasonId), seasonId, async (sid) =>
    unwrap(
      'load priorities',
      await supabase.rpc('attention', { p_season: sid, p_today: todayIso() }),
    ),
  )
}

export function useAttention(): UseQueryResult<Attention[], Error> {
  return useAttentionForSeason(useSeasonId())
}
