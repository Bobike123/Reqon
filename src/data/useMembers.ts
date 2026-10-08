import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError } from '../core/errors.ts'
import { fetchAllRows } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type Member = Database['public']['Tables']['members']['Row']
export type MemberState = Database['public']['Enums']['member_state']

// The club roster. Deliberately NOT season-scoped: `members` has no season_id,
// and people carry across seasons. Someone who leaves is retired
// (status = 'alumni'), never deleted, so owner names on old rows still resolve.
export function useMembers(): UseQueryResult<Member[], Error> {
  return useQuery({
    queryKey: queryKeys.members,
    queryFn: () =>
      fetchAllRows(
        'load members',
        (row: Member) => row.id,
        // full_name is not unique — two members could share a display name —
        // so id is added as the tie-breaker paging needs.
        (from, to) => supabase.from('members').select('*').order('full_name').order('id').range(from, to),
      ),
    staleTime: 5 * 60 * 1000,
  })
}

// Links a login that ALREADY exists (made in the Supabase dashboard) to the
// roster by its UUID. Creating the login itself needs the service_role key,
// which must NEVER reach a browser — it bypasses Row Level Security entirely —
// so that goes through the Edge Function in useCreateMember() below instead.
export function useAddMember() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { id: string; fullName: string; role: string }>({
    mutationFn: async ({ id, fullName, role }) => {
      const { error } = await supabase
        .from('members')
        .insert({ id, full_name: fullName, role })
      // RLS decides whether this is allowed: `admin_roster_insert` requires can_add_members().
      // Privileged roles are NOT set here — see roles/useMemberRoles.ts.
      if (error) throw new DataError('add people to the roster', error)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members })
    },
  })
}

export type NewMember = {
  email: string
  // A first password they change in Settings -> Your account. Sent once over
  // HTTPS to the Edge Function; never stored or shown by the app.
  password: string
  fullName: string
  jobTitle: string
}

// Creates the login AND the roster row in one step, through the `create-member`
// Edge Function (supabase/functions/create-member). The service-role key lives
// only there; the browser sends nothing but the signed-in person's own access
// token. The function asks the database — as that person — whether they may
// add members (can_add_members(): active President, Vice President or
// Developer), and inserts the roster row as them too, so RLS decides twice.
// Returns the new person's id.
export function useCreateMember() {
  const queryClient = useQueryClient()
  return useMutation<string, Error, NewMember>({
    mutationFn: async (member) => {
      const what = 'add people to the roster'
      const { data, error } = await supabase.functions.invoke<{ id: string }>('create-member', { body: member })
      if (error) {
        // A refusal or a validation problem comes back as JSON { error }; the
        // function words it for a club member, so it is shown as written.
        const response = (error as { context?: unknown }).context
        let status = 0
        let message: string | null = null
        if (response instanceof Response) {
          status = response.status
          try {
            const body: unknown = await response.json()
            if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
              message = (body as { error: string }).error
            }
          } catch {
            // Not JSON (a gateway error page): fall back to the generic wording.
          }
        }
        // 401 is an expired or missing session, not a refusal: say so instead
        // of "you don't have permission".
        if (status === 401) throw new DataError(message ?? 'Your session has expired. Sign in again.', null)
        if (status === 403) throw new DataError(what, null, { permission: true })
        throw new DataError(message ?? `${what}: ${error.message}`, null)
      }
      if (!data?.id) throw new DataError(`${what}: the server sent no answer`, null)
      return data.id
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members })
    },
  })
}

export type MemberEdit = {
  id: string
  fullName?: string
  role?: string
  studyYear?: string | null
  skills?: string | null
  phone?: string | null
  notes?: string | null
  // Retiring someone is a status change, never a delete: `members` has no
  // DELETE policy at all, so old owner references keep resolving forever.
  status?: MemberState
}

// An UPDATE that RLS refuses touches no rows and reports no error, so a
// caller with no permission and a caller who simply lost a race with a
// deleted/renamed row would look identical without asking the database which
// one happened.
async function isAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin')
  if (error) throw new DataError('check whether the change was saved', error)
  return data === true
}

export function useUpdateMember() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, MemberEdit>({
    mutationFn: async (edit) => {
      const { data, error } = await supabase
        .from('members')
        .update({
          ...(edit.fullName !== undefined ? { full_name: edit.fullName } : {}),
          ...(edit.role !== undefined ? { role: edit.role } : {}),
          ...(edit.studyYear !== undefined ? { study_year: edit.studyYear } : {}),
          ...(edit.skills !== undefined ? { skills: edit.skills } : {}),
          ...(edit.phone !== undefined ? { phone: edit.phone } : {}),
          ...(edit.notes !== undefined ? { notes: edit.notes } : {}),
          ...(edit.status !== undefined ? { status: edit.status } : {}),
        })
        .eq('id', edit.id)
        .select('id')
      if (error) throw new DataError('edit that member', error)
      if (data && data.length > 0) return
      if (await isAdmin()) {
        throw new DataError('save that member: they no longer exist on the roster', null)
      }
      throw new DataError('edit that member', null, { permission: true })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members })
    },
  })
}
