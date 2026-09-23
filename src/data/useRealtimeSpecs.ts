import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type SpecRow = Database['public']['Tables']['specs']['Row']

// specs is realtime, but useSpecsForSeason reads spec_verdicts — a VIEW that
// derives `verdict` in SQL from specs' own comparator/target/measured. A raw
// specs payload has no `verdict`, so patching it in would either drop the
// column or guess it — exactly the duplicated pass/fail logic useSetMeasurement
// (useSpecs.ts) already refuses to do for the same reason. Invalidate and let
// the view answer, instead.
export function useRealtimeSpecs(): RealtimeState {
  const queryClient = useQueryClient()

  return useSeasonRealtimeChannel<SpecRow>('specs', (_payload, seasonId) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.specVerdicts(seasonId) })
  })
}
