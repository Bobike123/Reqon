import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { fetchAllRows, unwrap } from './errors.ts'
import { useOptimisticListMutation } from './optimistic.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'
import type { Task, TaskPriority, TaskState } from '../tasks/types.ts'

export type { Task, TaskState, TaskPriority } from '../tasks/types.ts'

// The season-parameterized read. Prefer useTasks() for the current season —
// this exists so a mutation or a future multi-season view can ask for a
// SPECIFIC season without going through "whatever is current right now".
//
// Filters to archived_at IS NULL (R37.1, ADR-0004's "active-screen rule"):
// Board, Gantt planning, Now and Priorities all read through this one hook,
// and none of them is an archive/history view. A future archive browser
// (Phase 6) fetches separately rather than this hook growing an
// "includeArchived" flag every active-work consumer would have to remember
// to leave false.
export function useTasksForSeason(seasonId: string | undefined): UseQueryResult<Task[], Error> {
  return useSeasonScopedQuery<Task[]>(queryKeys.tasks(seasonId), seasonId, (sid) =>
    fetchAllRows(
      'load tasks',
      (row) => row.id,
      // created_at alone is not unique — two tasks can share a timestamp — so
      // id is added as the tie-breaker paging needs.
      (from, to) =>
        supabase
          .from('tasks')
          .select('*')
          .eq('season_id', sid)
          .is('archived_at', null)
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to),
    ),
  )
}

export function useTasks(): UseQueryResult<Task[], Error> {
  return useTasksForSeason(useSeasonId())
}

// Whether the signed-in caller may edit THIS task — a mirror of
// can_edit_task(id) (20260116000000), used only to distinguish "the write
// was refused because of who I am" from "the row disappeared (or was
// archived) out from under me" after a zero-row UPDATE. Never treated as
// authority; the database re-checks this itself on every write.
async function canEditTask(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_edit_task', { p_task_id: id })
  if (error) throw new DataError('check whether the change was saved', error)
  return data === true
}

// Only the fields ADR-0003's field table marks editable through an ordinary
// edit — never season_id, subteam_key, source_proposal, created_by/at,
// completed_at or archived_*: those are protected server-side
// (guard_task_edit) and have no place in a generic command type a screen
// could accidentally widen. Department transfer, archive and restore are
// separate, explicitly authorized commands (below / a future maintenance
// screen), never a side effect of this one.
export type TaskEdit = {
  id: string
  title?: string
  detail?: string | null
  state?: TaskState
  priority?: TaskPriority
  // Head-of-department or Developer only (guard_task_edit) — an owner
  // cannot reassign their own task away. The database is the only real
  // check; this type only says the field EXISTS, not who may set it.
  ownerId?: string | null
  startsOn?: string | null
  dueDate?: string | null
  starred?: boolean
  // Which milestone section this task is a subtask of, if any. Null detaches it
  // from the Gantt without touching the task itself — it stays on the Board.
  sectionId?: string | null
  // A task's milestone. The database keeps it consistent with sectionId and the
  // task's season (enforce_task_milestone_consistency): change the milestone and
  // the section together, or the write is refused. A task created from a proposal
  // can never have its milestone cleared.
  milestoneKey?: string | null
}

// Editing an existing task: optimistic, because the row is already in the cache
// and can be restored byte for byte if the write fails.
export function useUpdateTask() {
  // The season boundary, not a list-query observer: useUpdateTask() used to
  // call useTasks() just to read .seasonId off it, which meant every task
  // edit anywhere in the app silently mounted a second full tasks query.
  const seasonId = useSeasonId()

  return useOptimisticListMutation<Task, TaskEdit>({
    queryKey: queryKeys.tasks(seasonId),
    identify: (row, edit) => row.id === edit.id,
    // A task edit (its state, deadline, owner, or which milestone/section it is
    // linked to) changes what the progress list and Now's attention list say.
    alsoInvalidate: [queryKeys.progressTasks(seasonId), queryKeys.attention(seasonId)],

    write: async (edit) => {
      const { data, error } = await supabase
        .from('tasks')
        .update({
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.detail !== undefined ? { detail: edit.detail } : {}),
          ...(edit.state !== undefined ? { state: edit.state } : {}),
          ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
          ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
          ...(edit.startsOn !== undefined ? { starts_on: edit.startsOn } : {}),
          ...(edit.dueDate !== undefined ? { due_date: edit.dueDate } : {}),
          ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
          ...(edit.sectionId !== undefined ? { section_id: edit.sectionId } : {}),
          ...(edit.milestoneKey !== undefined ? { milestone_key: edit.milestoneKey } : {}),
        })
        .eq('id', edit.id)
        .select('id')
      // A protected-column attack or an invariant refusal (a promoted task's
      // due_date, an inactive owner) is a real raised error from
      // guard_task_edit — surfaces here exactly as thrown, not as a zero-row
      // match.
      if (error) throw new DataError('update task', error)
      if (data && data.length > 0) return
      // task_update's RLS refuses by matching zero rows, not by erroring —
      // ask the database whether THIS task specifically was ever editable by
      // this caller, so "you may not edit this" and "it no longer exists (or
      // was archived)" never read the same.
      if (await canEditTask(edit.id)) {
        throw new DataError('save that task: it no longer exists', null)
      }
      throw new DataError('update task', null, { permission: true })
    },

    apply: (rows, edit) =>
      rows.map((row) =>
        row.id === edit.id
          ? {
              ...row,
              ...(edit.title !== undefined ? { title: edit.title } : {}),
              ...(edit.detail !== undefined ? { detail: edit.detail } : {}),
              ...(edit.state !== undefined ? { state: edit.state } : {}),
              ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
              ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
              ...(edit.startsOn !== undefined ? { starts_on: edit.startsOn } : {}),
              ...(edit.dueDate !== undefined ? { due_date: edit.dueDate } : {}),
              ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
              ...(edit.sectionId !== undefined ? { section_id: edit.sectionId } : {}),
              ...(edit.milestoneKey !== undefined ? { milestone_key: edit.milestoneKey } : {}),
            }
          : row,
      ),
  })
}

// Archive and restore change which list a task belongs to, so every view of it
// is refreshed: the active list, the archive, progress and the requirement counts.
function useRefreshTaskViews() {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  return () => {
    if (!seasonId) return
    for (const key of [
      queryKeys.tasks(seasonId),
      queryKeys.archive(seasonId),
      queryKeys.progressTasks(seasonId),
      queryKeys.taskRequirements(seasonId),
    ]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }
}

// Archiving/restoring: not optimistic — archive_task()/restore_task() are
// server-computed commands (completion may change, archive metadata is
// stamped by the database), so the returned row is trusted over any local
// guess. Restoring a Done task reopens it (state todo) and keeps its history.
export function useArchiveTask() {
  const refresh = useRefreshTaskViews()
  return useMutation<Task, Error, { id: string; reason?: string }>({
    mutationFn: async ({ id, reason }) =>
      unwrap(
        'archive that task',
        await supabase.rpc('archive_task', { p_task_id: id, p_reason: reason ?? 'manual' }),
      ),
    onSuccess: refresh,
  })
}

export function useRestoreTask() {
  const refresh = useRefreshTaskViews()
  return useMutation<Task, Error, { id: string }>({
    mutationFn: async ({ id }) =>
      unwrap('restore that task', await supabase.rpc('restore_task', { p_task_id: id })),
    onSuccess: refresh,
  })
}

// Requirement links (ADR-0006). Same authority as editing the task: its owner,
// its department's Head, or a Developer (can_edit_task). Each returns whether
// anything changed, so a double click is harmless. Unlinking the last
// requirement of a task created from a proposal is refused by the database.
export function useLinkTaskRequirement() {
  const refresh = useRefreshTaskViews()
  return useMutation<boolean, Error, { taskId: string; clauseKey: string }>({
    mutationFn: async ({ taskId, clauseKey }) =>
      unwrap(
        'link that requirement',
        await supabase.rpc('link_task_requirement', { p_task_id: taskId, p_clause_key: clauseKey }),
      ),
    onSuccess: refresh,
  })
}

export function useUnlinkTaskRequirement() {
  const refresh = useRefreshTaskViews()
  return useMutation<boolean, Error, { taskId: string; clauseKey: string }>({
    mutationFn: async ({ taskId, clauseKey }) =>
      unwrap(
        'unlink that requirement',
        await supabase.rpc('unlink_task_requirement', { p_task_id: taskId, p_clause_key: clauseKey }),
      ),
    onSuccess: refresh,
  })
}
