import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, fetchAllRows } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'
import { useCurrentSeason } from './useCurrentSeason.ts'

export type FinanceEntry = Database['public']['Tables']['finance_entries']['Row']
export type FinanceKind = Database['public']['Enums']['finance_kind']
export type FinanceDraft = {
  entryDate: string
  kind: FinanceKind
  description: string
  category: string | null
  amountCents: number
}

// The season's ledger. Who may read it is decided by finance_read
// (can_view_finances()); anyone else gets no rows, so the screen does not even
// ask on their behalf — see Finances.tsx.
export function useFinanceEntries({ enabled = true }: { enabled?: boolean } = {}) {
  return useSeasonScopedQuery<FinanceEntry[]>(
    'finance_entries',
    (seasonId) =>
      fetchAllRows('load financial entries', (from, to) =>
        supabase
          .from('finance_entries')
          .select('*')
          .eq('season_id', seasonId)
          .order('entry_date', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to),
      ),
    { enabled },
  )
}

function useFinanceCache() {
  const queryClient = useQueryClient()
  const seasonId = useCurrentSeason().data?.id
  return {
    seasonId,
    invalidate: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.seasonScoped(seasonId, 'finance_entries') })
    },
  }
}

const toRow = (draft: FinanceDraft) => ({
  entry_date: draft.entryDate,
  kind: draft.kind,
  description: draft.description,
  category: draft.category,
  amount_cents: draft.amountCents,
})

// Only the Treasurer may write (finance_insert / finance_update /
// finance_delete). An UPDATE or DELETE that RLS refuses is not an error — it
// simply matches no rows — so when nothing was touched the database is asked
// whether the caller may manage finances at all, to tell "not allowed" apart
// from "someone already deleted it".
async function mayManageFinances(): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_manage_finances')
  // If the question itself failed (a network blip), say that — it is not a
  // refusal, and must not be shown as "Not permitted".
  if (error) throw new DataError('check whether the change was saved', error)
  return data === true
}

export function useAddFinanceEntry() {
  const { seasonId, invalidate } = useFinanceCache()
  return useMutation<void, Error, FinanceDraft>({
    mutationFn: async (draft) => {
      if (!seasonId) throw new DataError('add the entry: there is no current season', null)
      // created_by is stamped by the database from the session, not sent.
      const { error } = await supabase.from('finance_entries').insert({ season_id: seasonId, ...toRow(draft) })
      if (error) throw new DataError('add financial entries', error)
    },
    onSettled: invalidate,
  })
}

export function useUpdateFinanceEntry() {
  const { invalidate } = useFinanceCache()
  return useMutation<void, Error, FinanceDraft & { id: string }>({
    mutationFn: async ({ id, ...draft }) => {
      const { data, error } = await supabase
        .from('finance_entries')
        .update(toRow(draft))
        .eq('id', id)
        .select('id')
      if (error) throw new DataError('edit financial entries', error)
      if (data && data.length > 0) return
      if (await mayManageFinances()) {
        throw new DataError('save the entry: it no longer exists — someone may have deleted it', null)
      }
      throw new DataError('edit financial entries', null, { permission: true })
    },
    onSettled: invalidate,
  })
}

export function useDeleteFinanceEntry() {
  const { invalidate } = useFinanceCache()
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const { data, error } = await supabase.from('finance_entries').delete().eq('id', id).select('id')
      if (error) throw new DataError('delete financial entries', error)
      if (data && data.length > 0) return
      // Already gone is the outcome that was wanted.
      if (await mayManageFinances()) return
      throw new DataError('delete financial entries', null, { permission: true })
    },
    onSettled: invalidate,
  })
}
