import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type Member = Database['public']['Tables']['members']['Row']

// The club roster. Deliberately NOT season-scoped: `members` has no season_id,
// and people carry across seasons. Someone who leaves is retired
// (status = 'alumni'), never deleted, so owner names on old rows still resolve.
export function useMembers(): UseQueryResult<Member[], Error> {
  return useQuery({
    queryKey: queryKeys.members,
    queryFn: async () =>
      unwrap(
        'load members',
        await supabase.from('members').select('*').order('full_name'),
      ),
    staleTime: 5 * 60 * 1000,
  })
}
