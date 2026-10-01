import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { fetchAllRows, unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

// Read from the view, not the table. `verdict` (pass / fail / unmeasured /
// unevaluable), `goal_status` and `zone` are computed in SQL from the rule's
// own comparator, target and the internal goal, so they cannot go stale when a
// target changes. Pass/fail is never stored and never recomputed in React.
export type SpecVerdict = Database['public']['Views']['spec_verdicts']['Row']

export type SpecMeasurement = Database['public']['Tables']['spec_measurements']['Row']

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

// ---------------------------------------------------------------- history
// One specification's accepted and superseded observations, newest MEASURED
// first — the same order the database uses to pick the current value
// (measured_at, then recorded_at, then id; a legacy row with no known time is
// last). Read a page at a time: a long-lived spec accumulates many rows.
export const HISTORY_PAGE_SIZE = 25

export type SpecHistory = { rows: SpecMeasurement[]; hasMore: boolean }

export function useSpecMeasurements(
  specId: string | undefined,
  pageSize: number = HISTORY_PAGE_SIZE,
): UseInfiniteQueryResult<SpecHistory, Error> {
  const seasonId = useSeasonId()
  return useInfiniteQuery({
    queryKey: queryKeys.specMeasurements(seasonId, specId),
    enabled: Boolean(seasonId) && Boolean(specId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      unwrap<SpecMeasurement[]>(
        'load measurement history',
        await supabase
          .from('spec_measurements')
          .select('*')
          .eq('season_id', seasonId as string)
          .eq('spec_id', specId as string)
          .order('measured_at', { ascending: false, nullsFirst: false })
          .order('recorded_at', { ascending: false })
          .order('id', { ascending: false })
          .range(pageParam, pageParam + pageSize - 1),
      ),
    getNextPageParam: (last, all) => (last.length < pageSize ? undefined : all.length * pageSize),
    // A new observation shifts every later row down a place, so the last row of
    // one page can reappear first on the next; drop the repeat (by id).
    select: (data): SpecHistory => {
      const seen = new Set<string>()
      const rows: SpecMeasurement[] = []
      for (const page of data.pages) {
        for (const row of page) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          rows.push(row)
        }
      }
      const last = data.pages[data.pages.length - 1]
      return { rows, hasMore: (last?.length ?? 0) >= pageSize }
    },
  })
}

// ---------------------------------------------------------------- commands
// Deliberately NOT optimistic.
//
// Every write here goes through a database command that validates, appends to
// the history, refreshes the current value and writes the audit event in one
// transaction. The client cannot know which observation becomes current (a
// backdated one does not) or what the verdict is (the view derives it), so it
// writes, then re-reads, and the database stays the only place that decides.
//
// Who measured and when it was recorded are taken from the session on the
// server. `requestId` is only a retry identity: reusing it repeats the same
// save (one row), a new one is a new measurement — it never names an actor.
export type RecordMeasurement = {
  specId: string
  value: number | boolean
  requestId: string
  // ISO instant of the measurement; omitted, the server uses its own clock.
  measuredAt?: string
  note?: string
  source?: string
  // 'team' (default) is OUR observation and becomes the current value; 'competition' is a result read at
  // the event: separate, never the current value, recorded only by evidence authority (the server decides).
  context?: 'team' | 'competition'
  // The unit shown beside the input; the server refuses a value entered for another unit.
  unit?: string | null
}

export type CorrectMeasurement = {
  measurementId: string
  reason: string
  value: number | boolean
  requestId: string
  measuredAt?: string
}

function valueArgs(value: number | boolean) {
  return typeof value === 'boolean' ? { p_value_bool: value } : { p_value_numeric: value }
}

function useRefreshSpecs() {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  // `forSeason` is the season the command was issued under: a switch while the request is in flight must
  // still refresh the season that changed, not the one that is now current.
  return (forSeason: string | undefined = seasonId) => {
    if (!forSeason) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.specVerdicts(forSeason) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.specMeasurementsAll(forSeason) })
    // The audit trail gained an entry (readiness, direction, observation); do not depend on realtime for it.
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(forSeason) })
  }
}

export function useRecordMeasurement() {
  const seasonId = useSeasonId()
  const refresh = useRefreshSpecs()

  return useMutation<SpecMeasurement, Error, RecordMeasurement, { seasonId: string | undefined }>({
    onMutate: () => ({ seasonId }),
    mutationFn: async (input) => {
      if (!seasonId) throw new DataError('record a measurement: no season is selected', null)
      const { data, error } = await supabase.rpc('record_spec_measurement', {
        p_season_id: seasonId,
        p_spec_id: input.specId,
        p_request_id: input.requestId,
        ...valueArgs(input.value),
        ...(input.measuredAt ? { p_measured_at: input.measuredAt } : {}),
        ...(input.note ? { p_note: input.note } : {}),
        ...(input.source ? { p_source: input.source } : {}),
        ...(input.context ? { p_context: input.context } : {}),
        ...(input.unit ? { p_unit: input.unit } : {}),
      })
      if (error) throw new DataError('record a measurement', error)
      if (!data) throw new DataError('record a measurement: nothing was returned', null)
      return data
    },
    onSettled: (_data, _error, _vars, context) => refresh(context?.seasonId),
  })
}

// Replace an erroneous CONFIRMED value. The old observation stays in the
// history, marked invalidated with the reason; the corrected one is appended.
export function useCorrectMeasurement() {
  const refresh = useRefreshSpecs()
  const seasonId = useSeasonId()

  return useMutation<SpecMeasurement, Error, CorrectMeasurement, { seasonId: string | undefined }>({
    onMutate: () => ({ seasonId }),
    mutationFn: async (input) => {
      const { data, error } = await supabase.rpc('correct_spec_measurement', {
        p_measurement_id: input.measurementId,
        p_reason: input.reason,
        p_request_id: input.requestId,
        ...valueArgs(input.value),
        ...(input.measuredAt ? { p_measured_at: input.measuredAt } : {}),
      })
      if (error) throw new DataError('correct a measurement', error)
      if (!data) throw new DataError('correct a measurement: nothing was returned', null)
      return data
    },
    onSettled: (_data, _error, _vars, context) => refresh(context?.seasonId),
  })
}

// Withdraw a measurement without a replacement. The current value falls back
// to the next accepted observation, or to "not measured" — never to zero.
export function useInvalidateMeasurement() {
  const refresh = useRefreshSpecs()
  const seasonId = useSeasonId()

  return useMutation<SpecMeasurement, Error, { measurementId: string; reason: string }, { seasonId: string | undefined }>({
    onMutate: () => ({ seasonId }),
    mutationFn: async ({ measurementId, reason }) => {
      const { data, error } = await supabase.rpc('invalidate_spec_measurement', {
        p_measurement_id: measurementId,
        p_reason: reason,
      })
      if (error) throw new DataError('withdraw a measurement', error)
      if (!data) throw new DataError('withdraw a measurement: nothing was returned', null)
      return data
    },
    onSettled: (_data, _error, _vars, context) => refresh(context?.seasonId),
  })
}

// ------------------------------------------------------------- readiness
// "Checked and ready" is a person's confirmation of ONE exact current team measurement, with a note. It
// lapses on the server when that measurement is replaced, corrected or withdrawn, or the rule/targets
// change; the client never derives readiness itself, it reads spec_verdicts.readiness.
export function useConfirmReadiness() {
  const refresh = useRefreshSpecs()
  const seasonId = useSeasonId()
  return useMutation<unknown, Error, { specId: string; measurementId: string; note: string }, { seasonId: string | undefined }>({
    onMutate: () => ({ seasonId }),
    mutationFn: async ({ specId, measurementId, note }) => {
      const { data, error } = await supabase.rpc('confirm_spec_readiness', {
        p_spec_id: specId,
        p_measurement_id: measurementId,
        p_note: note,
      })
      if (error) throw new DataError('confirm readiness', error)
      return data
    },
    onSettled: (_data, _error, _vars, context) => refresh(context?.seasonId),
  })
}

export function useRevokeReadiness() {
  const refresh = useRefreshSpecs()
  const seasonId = useSeasonId()
  return useMutation<boolean, Error, { specId: string; reason: string }, { seasonId: string | undefined }>({
    onMutate: () => ({ seasonId }),
    mutationFn: async ({ specId, reason }) =>
      unwrap('withdraw the readiness confirmation', await supabase.rpc('revoke_spec_readiness', { p_spec_id: specId, p_reason: reason })),
    onSettled: (_data, _error, _vars, context) => refresh(context?.seasonId),
  })
}

// Which way is better for the project (higher or lower) for a specification whose direction was only
// derived from the regulatory minimum/maximum. President, Vice President or a Developer.
export function useReviewDirection() {
  const refresh = useRefreshSpecs()
  const seasonId = useSeasonId()
  return useMutation<unknown, Error, { specId: string; direction: 'higher_better' | 'lower_better'; note: string }, { seasonId: string | undefined }>({
    onMutate: () => ({ seasonId }),
    mutationFn: async ({ specId, direction, note }) => {
      const { data, error } = await supabase.rpc('review_spec_direction', { p_spec_id: specId, p_direction: direction, p_note: note })
      if (error) throw new DataError('review the direction', error)
      return data
    },
    onSettled: (_data, _error, _vars, context) => refresh(context?.seasonId),
  })
}
