import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'
import { useCurrentSeason } from './useCurrentSeason.ts'

// Real meetings: a date, a time, a place, an agenda and minutes.
//
// Not to be confused with task_proposals, which is what the screen called
// "Meetings" used to show. Who may do what is decided by the database
// (20260108000000_proposals_and_meetings.sql): everyone on the roster reads,
// administrators create and edit, and only a president or developer deletes.
export type Meeting = Database['public']['Tables']['meetings']['Row']

export type MeetingDraft = {
  title: string
  // YYYY-MM-DD. A meeting without a date is not a meeting, so this is required
  // here exactly as it is in the database (held_on date not null).
  heldOn: string
  // HH:MM, or null when the club has not fixed a time yet.
  startsAt: string | null
  endsAt: string | null
  location: string | null
  agenda: string | null
  notes: string | null
  attendees: string | null
}

export function useMeetings() {
  return useSeasonScopedQuery<Meeting[]>('meetings', async (seasonId) =>
    unwrap(
      'load meetings',
      await supabase
        .from('meetings')
        .select('*')
        .eq('season_id', seasonId)
        .order('held_on', { ascending: false })
        .order('starts_at', { ascending: false, nullsFirst: false }),
    ),
  ) as UseQueryResult<Meeting[], Error> & { seasonId: string | undefined }
}

function useMeetingCache() {
  const queryClient = useQueryClient()
  const seasonId = useCurrentSeason().data?.id
  return {
    seasonId,
    invalidate: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.seasonScoped(seasonId, 'meetings') })
    },
  }
}

const toRow = (draft: MeetingDraft) => ({
  title: draft.title,
  held_on: draft.heldOn,
  starts_at: draft.startsAt,
  ends_at: draft.endsAt,
  location: draft.location,
  agenda: draft.agenda,
  notes: draft.notes,
  attendees: draft.attendees,
})

// An UPDATE or DELETE that RLS refuses touches no rows and reports no error, so
// ask the database which of the two happened rather than guessing.
async function ask(fn: 'is_admin' | 'can_delete_records', what: string): Promise<boolean> {
  const { data, error } = await supabase.rpc(fn)
  if (error) throw new DataError(what, error)
  return data === true
}

export function useCreateMeeting() {
  const auth = useAuth()
  const { seasonId, invalidate } = useMeetingCache()

  return useMutation<Meeting, Error, MeetingDraft>({
    mutationFn: async (draft) => {
      if (auth.status !== 'member') throw new DataError('create the meeting: not signed in', null)
      if (!seasonId) throw new DataError('create the meeting: there is no current season', null)
      return unwrap(
        'call meetings',
        await supabase
          .from('meetings')
          .insert({ season_id: seasonId, created_by: auth.member.id, ...toRow(draft) })
          .select()
          .single(),
      )
    },
    onSettled: invalidate,
  })
}

export function useUpdateMeeting() {
  const { invalidate } = useMeetingCache()

  return useMutation<void, Error, MeetingDraft & { id: string }>({
    mutationFn: async ({ id, ...draft }) => {
      const { data, error } = await supabase
        .from('meetings')
        .update(toRow(draft))
        .eq('id', id)
        .select('id')
      if (error) throw new DataError('edit meetings', error)
      if (data && data.length > 0) return
      if (await ask('is_admin', 'check whether the meeting was saved')) {
        throw new DataError('save the meeting: it no longer exists — someone may have deleted it', null)
      }
      throw new DataError('edit meetings', null, { permission: true })
    },
    onSettled: invalidate,
  })
}

export function useDeleteMeeting() {
  const { invalidate } = useMeetingCache()

  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const { data, error } = await supabase.from('meetings').delete().eq('id', id).select('id')
      if (error) throw new DataError('delete meetings', error)
      if (data && data.length > 0) return
      // Already gone is the outcome that was wanted.
      if (await ask('can_delete_records', 'check whether the meeting was deleted')) return
      throw new DataError('delete meetings', null, { permission: true })
    },
    onSettled: invalidate,
  })
}

// The club's default agenda. One row, shared by everyone, so a new meeting
// starts from a structure instead of an empty box. Editing THIS is president or
// developer only; writing one meeting's own agenda and notes is not (see
// useUpdateMeeting).
export function useMeetingTemplate(): UseQueryResult<string, Error> {
  return useQuery({
    queryKey: queryKeys.meetingTemplate,
    queryFn: async () => {
      // The row type is stated here rather than inferred: meeting_template has
      // a boolean primary key (one row, forever) and the generated parser
      // resolves `*` on it to `never`.
      const rows = unwrap(
        'load the meeting template',
        await supabase
          .from('meeting_template')
          .select('body')
          .eq('id', true)
          .limit(1)
          .returns<{ body: string }[]>(),
      )
      return rows[0]?.body ?? ''
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useSaveMeetingTemplate() {
  const auth = useAuth()
  const queryClient = useQueryClient()

  return useMutation<void, Error, string>({
    mutationFn: async (body) => {
      if (auth.status !== 'member') throw new DataError('save the template: not signed in', null)
      const { data, error } = await supabase
        .from('meeting_template')
        .update({ body, updated_by: auth.member.id })
        .eq('id', true)
        .select('id')
      if (error) throw new DataError('change the meeting template', error)
      if (data && data.length === 0) {
        throw new DataError('change the meeting template', null, { permission: true })
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetingTemplate })
    },
  })
}
