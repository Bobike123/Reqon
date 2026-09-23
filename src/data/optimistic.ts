import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'

type Options<TRow, TVars> = {
  // The concrete cache key this mutation optimistically updates — e.g.
  // queryKeys.tasks(seasonId). A generic (seasonId, 'entity string') pair
  // used to build this internally; the caller now owns key construction, so
  // there is exactly one place (queryKeys.ts) that can get a key wrong.
  queryKey: readonly unknown[]
  // The actual write. Throw (or return a rejected promise) to trigger rollback.
  write: (vars: TVars) => Promise<unknown>
  // How the list should look while the server is still thinking. Must be pure,
  // and must only ever touch the one row `identify` singles out — this helper
  // rolls back exactly what `apply` changed on that row, nothing else.
  apply: (rows: TRow[], vars: TVars) => TRow[]
  // Which row in the list `vars` is about. Used to snapshot that one row
  // before the optimistic patch, and to find it again on rollback.
  identify: (row: TRow, vars: TVars) => boolean
}

type Snapshot<TRow> = { before: TRow; patch: Partial<TRow> } | undefined

// The five steps an optimistic write has to get right, in one place so that no
// individual mutation can forget one:
//
//   1. cancel in-flight reads, or a slow response lands on top of our guess
//   2. snapshot the one row this write is about to change
//   3. apply the optimistic value
//   4. undo just this write's own fields if it fails
//   5. invalidate afterwards so the server has the last word
//
// Step 4 used to restore the entire previous array. That is unsafe once two
// mutations can be in flight at the same time (Phase 7 §7.4): if mutation A
// (editing row X) fails after mutation B (editing row Y, or a different field
// of row X) has already applied its own optimistic patch on top, restoring
// A's whole-list snapshot would silently erase B's still-pending or
// already-succeeded change. Instead, on failure this only reverts the
// specific fields THIS mutation itself set on THIS row — and only where
// nothing else has changed that field since, so a newer optimistic write
// (or a real refetch) is never stamped over by an older one's rollback.
//
// Only use this where the previous state can be restored exactly — a list we
// already hold. Inserts do NOT use it: a row the server has not numbered yet
// has no id to reconcile, so those simply invalidate on success.
export function useOptimisticListMutation<TRow extends object, TVars>(
  options: Options<TRow, TVars>,
): UseMutationResult<unknown, Error, TVars, Snapshot<TRow>> {
  const queryClient = useQueryClient()
  const { queryKey, write, apply, identify } = options

  return useMutation<unknown, Error, TVars, Snapshot<TRow>>({
    mutationFn: write,

    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey }) // 1

      // Everything below reads and writes the cache with no `await` in
      // between, so no other mutation's onMutate/onError can interleave
      // between the read and the write — each overlapping mutation always
      // patches whatever is freshest in the cache at the moment it runs, on
      // top of anything an earlier one already applied.
      const rows = queryClient.getQueryData<TRow[]>(queryKey)
      if (!rows) return undefined
      const before = rows.find((row) => identify(row, vars)) // 2
      if (!before) return undefined

      const after = apply([before], vars)[0]
      const patch: Partial<TRow> = {}
      for (const key of Object.keys(after) as (keyof TRow)[]) {
        if (after[key] !== before[key]) patch[key] = after[key]
      }

      queryClient.setQueryData<TRow[]>(queryKey, apply(rows, vars)) // 3
      return { before, patch }
    },

    onError: (_error, vars, snapshot) => {
      if (!snapshot) return
      const { before, patch } = snapshot
      const current = queryClient.getQueryData<TRow[]>(queryKey)
      if (!current) return

      queryClient.setQueryData<TRow[]>(
        queryKey,
        current.map((row) => {
          if (!identify(row, vars)) return row
          const revert: Partial<TRow> = {}
          for (const key of Object.keys(patch) as (keyof TRow)[]) {
            // Only undo a field if it still holds the value THIS mutation set
            // it to. If something else has since moved it on, that newer
            // write wins — 4.
            if (row[key] === patch[key]) revert[key] = before[key]
          }
          return { ...row, ...revert }
        }),
      )
    },

    onSettled: () => {
      // 5 — success or failure, the server is the source of truth.
      void queryClient.invalidateQueries({ queryKey })
    },
  })
}
