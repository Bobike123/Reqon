import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query'
import type { ActivityRow } from '../activity/types.ts'
import { DataError } from '../core/errors.ts'
import { supabase } from '../lib/supabase.ts'
import { useSeasonId } from '../season/context.ts'
import { queryKeys } from './queryKeys.ts'

export type { ActivityRow }
export type ActivityHistory = { rows: ActivityRow[]; hasMore: boolean }

export const ACTIVITY_PAGE_SIZE = 15

// Entity history is intentionally lazy. Archive rows render quickly and only
// the item whose disclosure is opened asks for its audit pages.
export function useActivityHistory(
  entity: 'task' | 'proposal',
  entityId: string,
  enabled: boolean,
  pageSize: number = ACTIVITY_PAGE_SIZE,
): UseInfiniteQueryResult<ActivityHistory, Error> {
  const seasonId = useSeasonId()
  return useInfiniteQuery({
    queryKey: queryKeys.activity(seasonId, entity, entityId),
    enabled: Boolean(seasonId) && Boolean(entityId) && enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase
        .from('activity')
        .select('*')
        .eq('season_id', seasonId as string)
        .eq('entity', entity)
        .eq('entity_id', entityId)
        .order('at', { ascending: false })
        .order('id', { ascending: false })
        .range(pageParam, pageParam + pageSize - 1)
      if (error) throw new DataError('load change history', error)
      return data ?? []
    },
    getNextPageParam: (last, all) => (last.length < pageSize ? undefined : all.length * pageSize),
    select: (data): ActivityHistory => {
      const seen = new Set<number>()
      const rows: ActivityRow[] = []
      for (const page of data.pages) {
        for (const row of page) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          rows.push(row)
        }
      }
      return { rows, hasMore: (data.pages.at(-1)?.length ?? 0) >= pageSize }
    },
  })
}
