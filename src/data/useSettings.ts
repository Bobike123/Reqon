import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ROLE_LABELS, type PrivilegedRole } from '../auth/permissions.ts'
import { supabase } from '../lib/supabase.ts'
import type { RoleChange } from '../roles/rolePlan.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useCurrentSeason } from './useCurrentSeason.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type Season = Database['public']['Tables']['seasons']['Row']
export type Subteam = Database['public']['Tables']['subteams']['Row']
export type HandoverNote = Database['public']['Tables']['handover_notes']['Row']
export type MemberState = Database['public']['Enums']['member_state']

// --- Seasons ----------------------------------------------------------------
// The season LIST is not season-scoped — it is the list of seasons.
export function useSeasons(): UseQueryResult<Season[], Error> {
  return useQuery({
    queryKey: ['seasons'],
    queryFn: async () =>
      unwrap('load seasons', await supabase.from('seasons').select('*').order('label')),
  })
}

export function useCreateSeason() {
  const queryClient = useQueryClient()
  return useMutation<Season, Error, { label: string; edition: string | null }>({
    mutationFn: async ({ label, edition }) =>
      unwrap<Season>(
        'create a season',
        // Deliberately NOT current. Creating and switching are two separate,
        // reversible steps: a new season appearing does not silently move the
        // whole club onto it.
        await supabase
          .from('seasons')
          .insert({ label, edition: edition ?? undefined, is_current: false })
          .select()
          .single(),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['seasons'] })
    },
  })
}

// Switching goes through the set_current_season() database function, which does
// both writes in ONE transaction and checks is_admin() itself. Doing the two
// updates from here could leave the club with no current season at all if the
// second one failed. See supabase/migrations/20260104000000_set_current_season.sql
export function useSetCurrentSeason() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (seasonId) => {
      const { error } = await supabase.rpc('set_current_season', { p_season_id: seasonId })
      if (error) throw new DataError('switch the current season', error)
    },
    onSuccess: () => {
      // Everything in the app hangs off the season, so drop the lot: each
      // season keeps its own cache entries, nothing crosses over.
      void queryClient.invalidateQueries({ queryKey: ['seasons'] })
      void queryClient.invalidateQueries({ queryKey: queryKeys.currentSeason })
      void queryClient.invalidateQueries({ queryKey: ['season'] })
    },
  })
}

// --- Roster -----------------------------------------------------------------
// There is no "create the login" step here on purpose. Creating a Supabase Auth
// user needs the service_role key, which must NEVER reach a browser — it
// bypasses Row Level Security entirely. An administrator creates the account in the
// Supabase dashboard and pastes the resulting UUID here, which links the person
// to the roster. See the note rendered above this form in Settings.
export function useAddMember() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { id: string; fullName: string; role: string }>({
    mutationFn: async ({ id, fullName, role }) => {
      const { error } = await supabase
        .from('members')
        .insert({ id, full_name: fullName, role })
      // RLS decides whether this is allowed: `admin_roster_insert` requires is_admin().
      // Privileged roles are NOT set here — see useAssignRole().
      if (error) throw new DataError('add people to the roster', error)
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

export function useUpdateMember() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, MemberEdit>({
    mutationFn: async (edit) => {
      const { error } = await supabase
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
      if (error) throw new DataError('edit that member', error)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members })
    },
  })
}

// --- Subteams ---------------------------------------------------------------
export function useUpdateSubteam() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { key: string; name?: string; description?: string | null; leadId?: string | null }>({
    mutationFn: async (edit) => {
      const { error } = await supabase
        .from('subteams')
        .update({
          ...(edit.name !== undefined ? { name: edit.name } : {}),
          ...(edit.description !== undefined ? { description: edit.description } : {}),
          // The key is never touched: clauses reference subteams by key, and
          // renaming the key would orphan 1,146 rows.
          ...(edit.leadId !== undefined ? { lead_id: edit.leadId } : {}),
        })
        .eq('key', edit.key)
      if (error) throw new DataError('edit subsystems', error)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}

// --- Milestones -------------------------------------------------------------
export function useUpdateMilestone() {
  const queryClient = useQueryClient()
  const { data: season } = useCurrentSeason()
  const seasonId = season?.id
  return useMutation<void, Error, { key: string; opensOn?: string | null; dueOn?: string | null; maxPoints?: number }>({
    mutationFn: async (edit) => {
      const { error } = await supabase
        .from('milestones')
        .update({
          // A null date is legitimate and renders TBC. Blanking a date is a
          // real edit, not an error.
          ...(edit.opensOn !== undefined ? { opens_on: edit.opensOn } : {}),
          ...(edit.dueOn !== undefined ? { due_on: edit.dueOn } : {}),
          ...(edit.maxPoints !== undefined ? { max_points: edit.maxPoints } : {}),
        })
        .eq('key', edit.key)
      if (error) throw new DataError('edit milestones', error)
    },
    onSuccess: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.seasonScoped(seasonId, 'milestones') })
    },
  })
}

// --- Handover notes ---------------------------------------------------------
// One row per (season, subteam) — the schema's own unique key, so writes are an
// upsert on that pair. This is the only notes store; do not add another.
export function useHandoverNotes() {
  return useSeasonScopedQuery<HandoverNote[]>('handover_notes', async (seasonId) =>
    unwrap(
      'load handover notes',
      await supabase.from('handover_notes').select('*').eq('season_id', seasonId),
    ),
  ) as UseQueryResult<HandoverNote[], Error> & { seasonId: string | undefined }
}

export function useSetHandoverNote() {
  const queryClient = useQueryClient()
  const { seasonId } = useHandoverNotes()
  return useMutation<void, Error, { subteamKey: string; body: string; memberId: string }>({
    mutationFn: async ({ subteamKey, body, memberId }) => {
      if (!seasonId) throw new DataError('save handover note: no current season', null)
      const { error } = await supabase.from('handover_notes').upsert(
        { season_id: seasonId, subteam_key: subteamKey, body, updated_by: memberId },
        { onConflict: 'season_id,subteam_key' },
      )
      if (error) throw new DataError('save that handover note', error)
    },
    onSettled: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'handover_notes'),
      })
    },
  })
}

// --- Privileged roles -------------------------------------------------------
export type MemberRole = Database['public']['Tables']['member_roles']['Row']

export const roleKeys = {
  all: queryKeys.memberRoles,
  list: [...queryKeys.memberRoles, 'all'] as const,
}

// Who holds which role. Everyone on the roster may read this (role_read).
// Re-read every minute and on returning to the tab, so a change the President
// makes on another device shows up without a reload.
export function useMemberRoles(): UseQueryResult<MemberRole[], Error> {
  return useQuery({
    queryKey: roleKeys.list,
    queryFn: async () =>
      unwrap('load member roles', await supabase.from('member_roles').select('*')),
    refetchInterval: 60_000,
  })
}

// The two writes every role change is made of. Only the President may make
// either: the role_assign / role_remove policies in the database enforce that,
// and the controls appearing only for the President is a courtesy, not the
// protection. Both are safe to repeat, so a screen that was a little out of
// date cannot turn a correct intention into an error.
async function giveRole(memberId: string, role: PrivilegedRole): Promise<void> {
  // assigned_by is filled in by the database from the session; sending it
  // would only let the policy reject a forged value.
  const { error } = await supabase.from('member_roles').insert({ member_id: memberId, role })
  if (error?.code === '23505') return // they already hold it: the goal is met
  if (error) throw new DataError(`give the ${ROLE_LABELS[role]} role`, error)
}

async function takeRole(memberId: string, role: PrivilegedRole): Promise<void> {
  const { data, error } = await supabase
    .from('member_roles')
    .delete()
    .eq('member_id', memberId)
    .eq('role', role)
    .select()
  if (error) throw new DataError(`take away the ${ROLE_LABELS[role]} role`, error)
  if (data && data.length > 0) return
  // A delete that RLS refuses removes nothing and raises nothing. Ask the
  // database which it was: already gone (fine), or not allowed (say so).
  const { data: allowed, error: checkError } = await supabase.rpc('can_manage_roles')
  // A failed check is a failure, not a refusal: never report it as one.
  if (checkError) throw new DataError('check whether the role was removed', checkError)
  if (allowed === true) return
  throw new DataError(`take away the ${ROLE_LABELS[role]} role`, null, { permission: true })
}

export function useAssignRole() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { memberId: string; role: PrivilegedRole }>({
    mutationFn: ({ memberId, role }) => giveRole(memberId, role),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: roleKeys.all }),
  })
}

export function useRemoveRole() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { memberId: string; role: PrivilegedRole }>({
    mutationFn: ({ memberId, role }) => takeRole(memberId, role),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: roleKeys.all }),
  })
}

// A role change that stopped part-way: `applied` of `total` writes were made
// before one was refused. `cause` keeps the original error, so a permission
// refusal is still recognised as one.
export class RoleChangeError extends Error {
  applied: number
  total: number
  constructor(cause: Error, applied: number, total: number) {
    super(cause.message, { cause })
    this.name = 'RoleChangeError'
    this.applied = applied
    this.total = total
  }
}

// Applies a plan from src/roles/rolePlan.ts one write at a time, in its order
// (grants before removals, your own presidency last), and stops at the first
// refusal: carrying on after a failed hand-over could leave the club without
// the President it was about to get.
export function useApplyRoleChanges() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, RoleChange[]>({
    mutationFn: async (changes) => {
      for (const [index, change] of changes.entries()) {
        try {
          if (change.action === 'add') await giveRole(change.memberId, change.role)
          else await takeRole(change.memberId, change.role)
        } catch (error) {
          throw new RoleChangeError(
            error instanceof Error ? error : new Error(String(error)),
            index,
            changes.length,
          )
        }
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: roleKeys.all }),
  })
}
