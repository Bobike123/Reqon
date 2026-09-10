import type { UseQueryResult } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type Milestone = Database['public']['Tables']['milestones']['Row']
export type MilestoneSection =
  Database['public']['Tables']['milestone_sections']['Row']

// The MS1 deliverables. Season-scoped: dates and points are re-set each edition.
//
// A milestone with no due_on renders "TBC" — never a made-up date. MS1-7 has no
// published window, so that case is real, not a bug.
export function useMilestones() {
  return useSeasonScopedQuery<Milestone[]>('milestones', async (seasonId) =>
    unwrap(
      'load milestones',
      await supabase
        .from('milestones')
        .select('*')
        .eq('season_id', seasonId)
        .order('ordinal'),
    ),
  ) as UseQueryResult<Milestone[], Error> & { seasonId: string | undefined }
}

// Section checklists hang off milestones by key. The table itself has no
// season_id — it inherits the season from its parent milestone, so it is
// keyed here by season to stay in step with useMilestones.
export function useMilestoneSections() {
  return useSeasonScopedQuery<MilestoneSection[]>(
    'milestone_sections',
    async (seasonId) => {
      const milestones = unwrap(
        'load milestones for sections',
        await supabase.from('milestones').select('key').eq('season_id', seasonId),
      )
      const keys = milestones.map((m) => m.key)
      if (keys.length === 0) return []
      return unwrap(
        'load milestone sections',
        await supabase
          .from('milestone_sections')
          .select('*')
          .in('milestone_key', keys)
          .order('ordinal'),
      )
    },
  ) as UseQueryResult<MilestoneSection[], Error> & { seasonId: string | undefined }
}

// The subteam list is structural reference data, not season data.
export function useSubteams() {
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

// Ticking a section off a milestone checklist. `milestone_sections` has no
// updated_by column, so nothing is stamped here — do not invent one.
export function useSetSectionDrafted() {
  const queryClient = useQueryClient()
  const { seasonId } = useMilestoneSections()

  return useMutation<void, Error, { id: string; isDrafted: boolean }>({
    mutationFn: async ({ id, isDrafted }) => {
      const { error } = await supabase
        .from('milestone_sections')
        .update({ is_drafted: isDrafted })
        .eq('id', id)
      if (error) throw new DataError('update milestone section', error)
    },
    onSettled: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'milestone_sections'),
      })
    },
  })
}
