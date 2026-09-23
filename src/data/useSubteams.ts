import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError } from '../core/errors.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type Subteam = Database['public']['Tables']['subteams']['Row']

// The subteam list is structural reference data, not season data. Previously
// lived in useMilestones.ts, which was never the right domain for it — moved
// here (Phase 6 §6.2) so the subteam domain has one owner.
export function useSubteams(): UseQueryResult<Subteam[], Error> {
  return useQuery({
    queryKey: queryKeys.subteams,
    queryFn: async () =>
      unwrap(
        'load subteams',
        await supabase.from('subteams').select('*').order('sort_order'),
      ),
    staleTime: 60 * 60 * 1000,
  })
}

async function isAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin')
  if (error) throw new DataError('check whether the change was saved', error)
  return data === true
}

export function useUpdateSubteam() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { key: string; name?: string; description?: string | null; leadId?: string | null }>({
    mutationFn: async (edit) => {
      const { data, error } = await supabase
        .from('subteams')
        .update({
          ...(edit.name !== undefined ? { name: edit.name } : {}),
          ...(edit.description !== undefined ? { description: edit.description } : {}),
          // The key is never touched: clauses reference subteams by key, and
          // renaming the key would orphan 1,146 rows.
          ...(edit.leadId !== undefined ? { lead_id: edit.leadId } : {}),
        })
        .eq('key', edit.key)
        .select('key')
      if (error) throw new DataError('edit subsystems', error)
      if (data && data.length > 0) return
      if (await isAdmin()) {
        throw new DataError('save that subsystem: it no longer exists', null)
      }
      throw new DataError('edit subsystems', null, { permission: true })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}
