import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import { useSeasonId } from '../season/context.ts'
import type { TaskLink } from '../tasks/dependencies.ts'
import { fetchAllRows, unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

// Prerequisite links of the whole season (archived tasks included, so a link to
// finished-and-archived work still reads). Read once and shared by the Board
// and the Gantt; a link is tiny.
export function useTaskDependencies(): UseQueryResult<TaskLink[], Error> {
  const seasonId = useSeasonId()
  return useQuery({
    queryKey: queryKeys.taskDependencies(seasonId),
    enabled: Boolean(seasonId),
    queryFn: async () => {
      const rows = await fetchAllRows(
        'load task prerequisites',
        (row: TaskLink) => `${row.task_id}|${row.depends_on_task_id}`,
        (from, to) =>
          supabase
            .from('task_dependencies')
            .select('task_id, depends_on_task_id')
            .eq('season_id', seasonId as string)
            .order('task_id')
            .order('depends_on_task_id')
            .range(from, to),
      )
      return rows.map((r) => ({ task_id: r.task_id, depends_on_task_id: r.depends_on_task_id }))
    },
  })
}

type LinkVars = { taskId: string; dependsOnTaskId: string }

// Not optimistic: the database can refuse a link for reasons the screen cannot
// see (a circle two people close at once, a task archived a moment ago), so the
// list is only updated from the server's answer. Both return whether anything
// changed, so a double click or a retry is harmless.
function useDependencyMutation(what: string, rpc: 'add_task_dependency' | 'remove_task_dependency') {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  // The season the change was made in, captured when it starts: a season switch while the request is in
  // flight must still refresh the season whose links changed.
  return useMutation<boolean, Error, LinkVars, { seasonId: string | undefined }>({
    onMutate: () => ({ seasonId }),
    mutationFn: async ({ taskId, dependsOnTaskId }) =>
      unwrap(what, await supabase.rpc(rpc, { p_task_id: taskId, p_depends_on_task_id: dependsOnTaskId })),
    onSettled: (_data, _error, _vars, context) => {
      const forSeason = context?.seasonId ?? seasonId
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskDependencies(forSeason) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(forSeason) })
    },
  })
}

export function useAddTaskDependency() {
  return useDependencyMutation('link that prerequisite', 'add_task_dependency')
}

export function useRemoveTaskDependency() {
  return useDependencyMutation('remove that prerequisite', 'remove_task_dependency')
}
