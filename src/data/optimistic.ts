import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.ts'

type Options<TRow, TVars> = {
  entity: string
  seasonId: string | undefined
  // The actual write. Throw (or return a rejected promise) to trigger rollback.
  write: (vars: TVars) => Promise<unknown>
  // How the list should look while the server is still thinking. Must be pure.
  apply: (rows: TRow[], vars: TVars) => TRow[]
}

// The five steps an optimistic write has to get right, in one place so that no
// individual mutation can forget one:
//
//   1. cancel in-flight reads, or a slow response lands on top of our guess
//   2. snapshot the previous cache
//   3. apply the optimistic value
//   4. put the snapshot back if the write fails
//   5. invalidate afterwards so the server has the last word
//
// Only use this where the previous state can be restored exactly — a list we
// already hold. Inserts do NOT use it: a row the server has not numbered yet
// has no id to reconcile, so those simply invalidate on success.
export function useOptimisticListMutation<TRow, TVars>(
  options: Options<TRow, TVars>,
): UseMutationResult<unknown, Error, TVars, { previous: TRow[] | undefined }> {
  const queryClient = useQueryClient()
  const { entity, seasonId, write, apply } = options

  return useMutation<unknown, Error, TVars, { previous: TRow[] | undefined }>({
    mutationFn: write,

    onMutate: async (vars) => {
      if (!seasonId) return { previous: undefined }
      const key = queryKeys.seasonScoped(seasonId, entity)

      await queryClient.cancelQueries({ queryKey: key })          // 1
      const previous = queryClient.getQueryData<TRow[]>(key)      // 2
      if (previous) {
        queryClient.setQueryData<TRow[]>(key, apply(previous, vars)) // 3
      }
      return { previous }
    },

    onError: (_error, _vars, context) => {
      if (!seasonId || !context?.previous) return
      // 4 — put back exactly what was there before.
      queryClient.setQueryData(queryKeys.seasonScoped(seasonId, entity), context.previous)
    },

    onSettled: () => {
      if (!seasonId) return
      // 5 — success or failure, the server is the source of truth.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, entity),
      })
    },
  })
}
