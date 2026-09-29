import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type SpecRow = Database['public']['Tables']['specs']['Row']
type MeasurementRow = Database['public']['Tables']['spec_measurements']['Row']

// Two tables feed the Spec Sheet, and both are read through something a raw
// payload cannot reconstruct, so both only INVALIDATE:
//
//  * specs — the screen reads spec_verdicts, a VIEW that derives verdict,
//    goal status and zone in SQL. A raw specs payload has no such columns, so
//    patching it in would drop them or guess them (the duplicated pass/fail
//    logic the view exists to prevent). A rule or target edit, and every
//    change of the current value (its cache columns live on this row), arrive
//    here.
//  * spec_measurements — the history. A backdated or invalidated observation
//    may not change the current value at all, so no specs event follows; this
//    channel is what refreshes an open history. It also refreshes the
//    verdicts, since a correction changes the current value.
//
// The database, not the payload, says which observation is current and what
// the verdict is.
export function useRealtimeSpecs(): RealtimeState {
  const queryClient = useQueryClient()

  const specs = useSeasonRealtimeChannel<SpecRow>('specs', (_payload, seasonId) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.specVerdicts(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
  }, {
    onSubscribed: (seasonId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.specVerdicts(seasonId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
    },
  })
  const history = useSeasonRealtimeChannel<MeasurementRow>('spec_measurements', (_payload, seasonId) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.specMeasurementsAll(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.specVerdicts(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
  }, {
    onSubscribed: (seasonId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.specMeasurementsAll(seasonId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.specVerdicts(seasonId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
    },
  })

  // "Live" only when both are; one still connecting keeps the label honest.
  if (specs === history) return specs
  if (specs === 'off' || history === 'off') return 'off'
  return 'connecting'
}
