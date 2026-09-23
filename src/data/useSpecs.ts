import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { fetchAllRows } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

// Read from the view, not the table. `verdict` (pass / fail / unmeasured) is
// computed in SQL from the rule's own comparator and target, so it cannot go
// stale when a target changes. Pass/fail is never stored and never recomputed
// in React.
export type SpecVerdict = Database['public']['Views']['spec_verdicts']['Row']

export function useSpecsForSeason(seasonId: string | undefined): UseQueryResult<SpecVerdict[], Error> {
  return useSeasonScopedQuery<SpecVerdict[]>(queryKeys.specVerdicts(seasonId), seasonId, (sid) =>
    fetchAllRows(
      'load spec verdicts',
      // The view marks every column nullable, but `id` is the underlying
      // specs.id and is never actually null for a real row; sort_order is the
      // fallback only a malformed row could ever need.
      (row) => row.id ?? `${row.clause_key}:${row.sort_order}`,
      (from, to) =>
        supabase.from('spec_verdicts').select('*').eq('season_id', sid).order('sort_order').order('id').range(from, to),
    ),
  )
}

export function useSpecs(): UseQueryResult<SpecVerdict[], Error> {
  return useSpecsForSeason(useSeasonId())
}

export type Measurement = { id: string; measured: number | null }

// Deliberately NOT optimistic.
//
// The cache holds rows from spec_verdicts, whose `verdict` column is derived in
// SQL. Guessing the new row locally would mean re-implementing the pass/fail
// rule in React — exactly the duplication the view exists to prevent, and the
// first thing to go wrong when a comparator changes. So this writes, then
// re-reads, and the database stays the only place that decides pass or fail.
export function useSetMeasurement() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()

  return useMutation<void, Error, Measurement>({
    mutationFn: async ({ id, measured }) => {
      if (auth.status !== 'member') {
        throw new DataError('save measurement: not signed in as a member', null)
      }
      const { error } = await supabase
        .from('specs')
        .update({
          measured,
          // Who measured it and when — specs uses measured_by/measured_at
          // rather than updated_by.
          measured_by: measured === null ? null : auth.member.id,
          measured_at: measured === null ? null : new Date().toISOString(),
        })
        .eq('id', id)
      if (error) throw new DataError('save measurement', error)
    },
    onSettled: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.specVerdicts(seasonId) })
    },
  })
}
