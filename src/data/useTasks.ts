import { useMutation, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
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
  // Why the task is Blocked when no prerequisite task explains it (an external
  // blocker). Sent together with state: 'blocked'; the database clears it when
  // the task leaves Blocked and refuses it on any other state.
  blockedReason?: string | null
}

// Every edit is a versioned write: it carries the updated_at of the row the
// person was looking at, and the database matches nothing if the row has moved
// on. That is what stops a stale screen (a dropped connection, an old tab)
// silently overwriting someone else's change — the field-level UPDATE alone
// cannot tell "my copy is old" from "my copy is current".
//
// Edits to ONE task are queued: a second edit fired while the first is still
// in flight would otherwise carry a version the first is about to make stale
// and fail with a false conflict. The version is read from the cache when the
// edit actually starts, after the previous edit has merged its result.
const taskWrites = new Map<string, Promise<unknown>>()

// The last version THIS client wrote per task. A refetch that was started before
// our own write committed can land afterwards and put an older row back in the
// cache; the next edit must not then carry that older version and be refused as
// a conflict with our own change. PostgREST writes every timestamp in one format
// and zone, so the newer of two versions is the later string.
// Kept per QueryClient (so a new session starts empty) and dropped as soon as the cache has caught up.
const lastWrittenByClient = new WeakMap<QueryClient, Map<string, string>>()
function lastWrittenFor(queryClient: QueryClient): Map<string, string> {
  let map = lastWrittenByClient.get(queryClient)
  if (!map) {
    map = new Map()
    lastWrittenByClient.set(queryClient, map)
  }
  return map
}

function cachedVersion(queryClient: QueryClient, seasonId: string | undefined, id: string): string | null {
  const rows = queryClient.getQueryData<Task[]>(queryKeys.tasks(seasonId))
  const cached = rows?.find((row) => row.id === id)?.updated_at ?? null
  if (cached === null) return null // not on this screen's list: no baseline to compare against
  const map = lastWrittenFor(queryClient)
  const written = map.get(id) ?? null
  if (written !== null && written <= cached) map.delete(id) // the cache has caught up
  return written !== null && written > cached ? written : cached
}

async function writeVersionedEdit(queryClient: QueryClient, seasonId: string | undefined, edit: TaskEdit): Promise<void> {
  const baseline = cachedVersion(queryClient, seasonId, edit.id)
  let query = supabase
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
      ...(edit.blockedReason !== undefined ? { blocked_reason: edit.blockedReason } : {}),
    })
    .eq('id', edit.id)
  if (baseline !== null) query = query.eq('updated_at', baseline)
  const { data, error } = await query.select('*')
  // A protected-column attack or an invariant refusal (a promoted task's
  // due_date, an inactive owner, a Blocked task with no reason) is a real raised
  // error from guard_task_edit — it surfaces here exactly as thrown, not as a
  // zero-row match.
  if (error) throw new DataError('update task', error)
  if (data && data.length > 0) {
    // Take only what the SERVER decided from the answer — the new version and the
    // stamps it sets — so the next edit of this task carries the version just
    // written, without stamping over a later edit's still-pending optimistic value.
    const saved = data[0]
    lastWrittenFor(queryClient).set(edit.id, saved.updated_at)
    queryClient.setQueryData<Task[]>(queryKeys.tasks(seasonId), (rows) =>
      rows?.map((row) =>
        row.id === edit.id
          ? {
              ...row,
              updated_at: saved.updated_at,
              completed_at: saved.completed_at,
              completion_source: saved.completion_source,
              blocked_since: saved.blocked_since,
            }
          : row,
      ),
    )
    return
  }
  // Zero rows: the row is gone, someone changed it first, or this caller may
  // not edit it. Ask which, so each reads differently and none is called "saved".
  const { data: current, error: readError } = await supabase
    .from('tasks')
    .select('id, updated_at, archived_at')
    .eq('id', edit.id)
    .maybeSingle()
  if (readError) throw new DataError('check whether the change was saved', readError)
  if (current === null) throw new DataError('save that task: it no longer exists', null)
  if (current.archived_at !== null) {
    throw new DataError('save that task: it has been archived since you opened it. Restore it from the Archive to edit it.', null)
  }
  if (baseline !== null && current.updated_at !== baseline) {
    throw new DataError(
      'That task was changed by someone else after you opened it, so nothing was saved. It has been refreshed; check it and apply your change again.',
      null,
      { conflict: true },
    )
  }
  if (await canEditTask(edit.id)) {
    throw new DataError('save that task: the change matched nothing', null)
  }
  throw new DataError('update task', null, { permission: true })
}

// Editing an existing task: optimistic, because the row is already in the cache
// and can be restored byte for byte if the write fails.
export function useUpdateTask() {
  // The season boundary, not a list-query observer: useUpdateTask() used to
  // call useTasks() just to read .seasonId off it, which meant every task
  // edit anywhere in the app silently mounted a second full tasks query.
  const seasonId = useSeasonId()
  const queryClient = useQueryClient()

  return useOptimisticListMutation<Task, TaskEdit>({
    queryKey: queryKeys.tasks(seasonId),
    identify: (row, edit) => row.id === edit.id,
    // A task edit (its state, deadline, owner, or which milestone/section it is
    // linked to) changes what the progress list and Now's attention list say.
    alsoInvalidate: [queryKeys.progressTasks(seasonId), queryKeys.attention(seasonId)],

    write: async (edit) => {
      const previous = taskWrites.get(edit.id)
      const run = (async () => {
        if (previous) await previous.catch(() => undefined)
        return writeVersionedEdit(queryClient, seasonId, edit)
      })()
      taskWrites.set(edit.id, run)
      try {
        return await run
      } finally {
        if (taskWrites.get(edit.id) === run) taskWrites.delete(edit.id)
      }
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
              ...(edit.blockedReason !== undefined ? { blocked_reason: edit.blockedReason } : {}),
              ...(edit.state !== undefined && edit.state !== 'blocked' ? { blocked_reason: null, blocked_since: null } : {}),
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

// Giving a task a department, or moving it to another one: never part of the
// ordinary edit (guard_task_edit refuses subteam_key there), but its own command,
// set_task_department(), with a required reason that the audit trail keeps. The
// President, Vice President or a Developer may assign any task; a Head may move
// work between departments they head. The database decides; not optimistic.
export function useSetTaskDepartment() {
  const refresh = useRefreshTaskViews()
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  return useMutation<Task, Error, { id: string; departmentKey: string; reason: string }>({
    mutationFn: async ({ id, departmentKey, reason }) =>
      unwrap(
        'move that task to another department',
        await supabase.rpc('set_task_department', { p_task_id: id, p_subteam_key: departmentKey, p_reason: reason }),
      ),
    onSuccess: () => {
      refresh()
      // The department lists on Now and the task's own history change too.
      if (seasonId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.attention(seasonId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
      }
    },
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
