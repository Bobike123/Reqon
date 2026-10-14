import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { DataError } from '../core/errors.ts'
import type { Database } from '../lib/database.types.ts'
import { supabase } from '../lib/supabase.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

// The club's service logins (migration 20260136000000). The President and Developers can read the rows and
// nothing else: the password is encrypted in Supabase Vault and comes out only through
// reveal_club_credential(), once, at the moment someone presses Copy.

export type ClubCredential = Pick<
  Database['public']['Tables']['club_credentials']['Row'],
  'id' | 'service' | 'login' | 'has_secret' | 'sort_order' | 'updated_at' | 'updated_by' | 'last_revealed_at' | 'last_revealed_by'
>

// Listed one by one on purpose: the database refuses `select *` because secret_id (the Vault pointer) is not
// granted to browsers.
const COLUMNS = 'id, service, login, has_secret, sort_order, updated_at, updated_by, last_revealed_at, last_revealed_by'

// `enabled` is false while the overlay is closed, so Settings itself never touches the table.
export function useClubCredentials(enabled: boolean): UseQueryResult<ClubCredential[], Error> {
  return useQuery({
    queryKey: queryKeys.clubCredentials,
    enabled,
    queryFn: async () =>
      unwrap(
        'load the club accounts',
        await supabase.from('club_credentials').select(COLUMNS).order('sort_order').order('service'),
      ),
    staleTime: 30_000,
  })
}

// The password, handed back ONLY so the caller can put it on the clipboard. Never keep the result in state,
// in the query cache or in the page: let it go out of scope as soon as it is copied.
export async function revealClubCredential(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('reveal_club_credential', { p_id: id })
  if (error) throw new DataError('copy this password', error)
  if (typeof data !== 'string' || data === '') throw new DataError('copy this password: the server sent no password', null)
  return data
}

// Change the login and/or the password. An empty password keeps the saved one.
export function useSaveClubCredential() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { id: string; login: string; secret: string }>({
    mutationFn: async ({ id, login, secret }) => {
      const { error } = await supabase.rpc('save_club_credential', {
        p_id: id,
        p_login: login,
        // Omitted (not sent as null) when blank, so the function's default keeps the old password.
        ...(secret === '' ? {} : { p_secret: secret }),
      })
      if (error) throw new DataError('change this account', error)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.clubCredentials }),
  })
}
