import type { UseQueryResult } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'
import type { Milestone, MilestoneSection } from '../milestones/types.ts'

export type { Milestone, MilestoneSection } from '../milestones/types.ts'

// The MS1 deliverables. Season-scoped: dates and points are re-set each edition.
//
// A milestone with no due_on renders "TBC" — never a made-up date. MS1-7 has no
// published window, so that case is real, not a bug.
export function useMilestonesForSeason(seasonId: string | undefined): UseQueryResult<Milestone[], Error> {
  return useSeasonScopedQuery<Milestone[]>(queryKeys.milestones(seasonId), seasonId, async (sid) =>
    unwrap(
      'load milestones',
      await supabase.from('milestones').select('*').eq('season_id', sid).order('ordinal'),
    ),
  )
}

export function useMilestones(): UseQueryResult<Milestone[], Error> {
  return useMilestonesForSeason(useSeasonId())
}

// Section checklists hang off milestones by key. The table itself has no
// season_id — it inherits the season from its parent milestone.
//
// `milestoneKeys` comes from the caller's own useMilestones() (Phase 7 §7.5):
// this used to re-select `milestones.key` here just to build the `.in(...)`
// filter, even though every screen that reads sections already has the full
// milestone rows loaded a moment earlier. Passing the keys in removes that
// second, redundant round trip without hiding a cache dependency — the query
// stays disabled (via `enabled`) until the caller actually has keys to give it.
export function useMilestoneSectionsForSeason(
  seasonId: string | undefined,
  milestoneKeys: string[] | undefined,
): UseQueryResult<MilestoneSection[], Error> {
  return useSeasonScopedQuery<MilestoneSection[]>(
    queryKeys.milestoneSections(seasonId),
    seasonId,
    async () => {
      const keys = milestoneKeys ?? []
      if (keys.length === 0) return []
      return unwrap(
        'load milestone sections',
        await supabase.from('milestone_sections').select('*').in('milestone_key', keys).order('ordinal'),
      )
    },
    { enabled: milestoneKeys !== undefined },
  )
}

export function useMilestoneSections(milestoneKeys: string[] | undefined): UseQueryResult<MilestoneSection[], Error> {
  return useMilestoneSectionsForSeason(useSeasonId(), milestoneKeys)
}

async function isAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin')
  if (error) throw new DataError('check whether the change was saved', error)
  return data === true
}

// A milestone's own submission window and points, edited from Settings. Moved
// here from useSettings.ts (Phase 6 §6.2): the milestones domain, not the
// Settings screen, owns this mutation.
export function useUpdateMilestone() {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  return useMutation<void, Error, { key: string; opensOn?: string | null; dueOn?: string | null; maxPoints?: number }>({
    mutationFn: async (edit) => {
      const { data, error } = await supabase
        .from('milestones')
        .update({
          // A null date is legitimate and renders TBC. Blanking a date is a
          // real edit, not an error.
          ...(edit.opensOn !== undefined ? { opens_on: edit.opensOn } : {}),
          ...(edit.dueOn !== undefined ? { due_on: edit.dueOn } : {}),
          ...(edit.maxPoints !== undefined ? { max_points: edit.maxPoints } : {}),
        })
        .eq('key', edit.key)
        .select('key')
      if (error) throw new DataError('edit milestones', error)
      if (data && data.length > 0) return
      if (await isAdmin()) {
        throw new DataError('save that milestone: it no longer exists', null)
      }
      throw new DataError('edit milestones', null, { permission: true })
    },
    onSuccess: () => {
      if (!seasonId) return
      // The timeline, the Milestones list and Now's "next deadline" all read this
      // one season-scoped key. Other seasons' caches are untouched.
      void queryClient.invalidateQueries({ queryKey: queryKeys.milestones(seasonId) })
      // A moved deadline changes which tasks count as late against it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(seasonId) })
    },
  })
}

// Ticking a section off a milestone checklist. `milestone_sections` has no
// updated_by column, so nothing is stamped here — do not invent one.
export function useSetSectionDrafted() {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()

  return useMutation<void, Error, { id: string; isDrafted: boolean }>({
    mutationFn: async ({ id, isDrafted }) => {
      const { data, error } = await supabase
        .from('milestone_sections')
        .update({ is_drafted: isDrafted })
        .eq('id', id)
        .select('id')
      if (error) throw new DataError('update milestone section', error)
      if (data && data.length > 0) return
      // RLS refuses by matching no rows. Only an ACTIVE member may write (20260118),
      // so ask which it was rather than report a save that never happened.
      const { data: active, error: askError } = await supabase.rpc('is_active_member')
      if (askError) throw new DataError('check whether the change was saved', askError)
      if (active === true) throw new DataError('save that section: it no longer exists', null)
      throw new DataError('update milestone section', null, { permission: true })
    },
    onSettled: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.milestoneSections(seasonId) })
    },
  })
}

// Recording that a milestone was SUBMITTED to the organisers and that they ACCEPTED it. These are two dates
// a person records; finishing every linked task records neither. The database checks who may (President,
// Vice President, Developer, Documentation), keeps acceptance after submission, refuses future dates and
// audits every change. Not optimistic: the stamps (who, when) come from the server.
export function useSetMilestoneSubmission() {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  return useMutation<unknown, Error, { key: string; submittedOn: string | null; acceptedOn: string | null }, { seasonId: string | undefined }>({
    // The season the command was issued under, so a switch mid-request refreshes the right one.
    onMutate: () => ({ seasonId }),
    mutationFn: async ({ key, submittedOn, acceptedOn }) => {
      const { data, error } = await supabase.rpc('set_milestone_submission', {
        p_key: key,
        // The functions treat NULL as "clear", so both are always sent.
        p_submitted_on: submittedOn as string,
        p_accepted_on: acceptedOn as string,
      })
      if (error) throw new DataError('record the submission', error)
      return data
    },
    onSettled: (_data, _error, _vars, context) => {
      const forSeason = context?.seasonId ?? seasonId
      if (!forSeason) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.milestones(forSeason) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(forSeason) })
    },
  })
}
