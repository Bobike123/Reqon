import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
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
        'create season',
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
// both writes in ONE transaction and checks is_board() itself. Doing the two
// updates from here could leave the club with no current season at all if the
// second one failed. See supabase/migrations/20260104000000_set_current_season.sql
export function useSetCurrentSeason() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (seasonId) => {
      const { error } = await supabase.rpc('set_current_season', { p_season_id: seasonId })
      if (error) throw new DataError('switch current season', error)
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
// bypasses Row Level Security entirely. The board creates the account in the
// Supabase dashboard and pastes the resulting UUID here, which links the person
// to the roster. See the note rendered above this form in Settings.
export function useAddMember() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { id: string; fullName: string; role: string; isBoard: boolean }>({
    mutationFn: async ({ id, fullName, role, isBoard }) => {
      const { error } = await supabase
        .from('members')
        .insert({ id, full_name: fullName, role, is_board: isBoard })
      // RLS decides whether this is allowed: `board_roster` requires is_board().
      if (error) throw new DataError('add member to the roster', error)
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
  isBoard?: boolean
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
          ...(edit.isBoard !== undefined ? { is_board: edit.isBoard } : {}),
          ...(edit.status !== undefined ? { status: edit.status } : {}),
        })
        .eq('id', edit.id)
      if (error) throw new DataError('update member', error)
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
      if (error) throw new DataError('update subteam', error)
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
      if (error) throw new DataError('update milestone', error)
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
      if (error) throw new DataError('save handover note', error)
    },
    onSettled: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'handover_notes'),
      })
    },
  })
}
