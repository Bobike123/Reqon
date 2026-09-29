import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { DataError } from '../core/errors.ts'
import { supabase } from '../lib/supabase.ts'
import { useSeasonId } from '../season/context.ts'
import type { Proposal } from '../proposals/types.ts'
import type { Task } from '../tasks/types.ts'
import { fetchAllRows } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useTasksForSeason } from './useTasks.ts'

// Reads that are NOT the active Board or the active proposal queue: history,
// provenance lookups, requirement counts and progress. Kept out of useTasks.ts
// so the active-work hook stays exactly "active tasks" and no screen has to
// remember an includeArchived flag.

export const ARCHIVE_PAGE_SIZE = 25
export type Page<T> = { rows: T[]; total: number }

// PostgREST answers a page past the end of a filtered result with 416; that is
// simply "no rows on this page", not a failure.
const PAST_THE_END = 'PGRST103'

// A user's search text goes inside an ilike pattern: escape its own wildcards so
// "50%" means 50 percent, not "50 followed by anything".
export function likePattern(text: string): string {
  return `%${text.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

// The filters of the archive's task list. '' means "any"; department NO_DEPARTMENT
// means older tasks that never had one.
export const NO_DEPARTMENT = 'none'
export type ArchivedTaskQuery = {
  department: string
  owner: string
  state: string
  search: string
  // Exactly one task, for provenance links.
  id: string
  page: number
}

export function useArchivedTasks(q: ArchivedTaskQuery): UseQueryResult<Page<Task>, Error> {
  const seasonId = useSeasonId()
  return useQuery({
    queryKey: queryKeys.archivedTasks(seasonId, q),
    enabled: Boolean(seasonId),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let query = supabase
        .from('tasks')
        .select('*', { count: 'exact' })
        .eq('season_id', seasonId as string)
        .not('archived_at', 'is', null)
      if (q.id) query = query.eq('id', q.id)
      if (q.department === NO_DEPARTMENT) query = query.is('subteam_key', null)
      else if (q.department) query = query.eq('subteam_key', q.department)
      if (q.owner) query = query.eq('owner_id', q.owner)
      if (q.state) query = query.eq('state', q.state as Task['state'])
      if (q.search.trim()) query = query.ilike('title', likePattern(q.search))
      const from = q.page * ARCHIVE_PAGE_SIZE
      const { data, error, count } = await query
        .order('archived_at', { ascending: false })
        .order('id')
        .range(from, from + ARCHIVE_PAGE_SIZE - 1)
      if (error?.code === PAST_THE_END) return { rows: [], total: count ?? 0 }
      if (error) throw new DataError('load archived tasks', error)
      return { rows: data ?? [], total: count ?? 0 }
    },
  })
}

// Proposals that are no longer live: approved (promoted), rejected, or decided
// with no recorded outcome. `status` 'other' is the last of these.
export type ProposalHistoryQuery = {
  department: string
  owner: string
  status: '' | 'approved' | 'rejected' | 'other'
  search: string
  id: string
  page: number
}

export function useProposalHistory(q: ProposalHistoryQuery): UseQueryResult<Page<Proposal>, Error> {
  const seasonId = useSeasonId()
  return useQuery({
    queryKey: queryKeys.proposalHistory(seasonId, q),
    enabled: Boolean(seasonId),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let query = supabase
        .from('task_proposals')
        .select('*', { count: 'exact' })
        .eq('season_id', seasonId as string)
        .or('archived_at.not.is.null,state.eq.decided')
      if (q.id) query = query.eq('id', q.id)
      if (q.department === NO_DEPARTMENT) query = query.is('subteam_key', null)
      else if (q.department) query = query.eq('subteam_key', q.department)
      if (q.owner) query = query.eq('owner_id', q.owner)
      if (q.status === 'approved' || q.status === 'rejected') query = query.eq('outcome', q.status)
      if (q.status === 'other') query = query.is('outcome', null)
      if (q.search.trim()) query = query.ilike('title', likePattern(q.search))
      const from = q.page * ARCHIVE_PAGE_SIZE
      const { data, error, count } = await query
        .order('archived_at', { ascending: false, nullsFirst: false })
        .order('decided_at', { ascending: false, nullsFirst: false })
        .order('id')
        .range(from, from + ARCHIVE_PAGE_SIZE - 1)
      if (error?.code === PAST_THE_END) return { rows: [], total: count ?? 0 }
      if (error) throw new DataError('load proposal history', error)
      return { rows: data ?? [], total: count ?? 0 }
    },
  })
}

const CHUNK = 40
function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

export type SourceProposal = Pick<Proposal, 'id' | 'title' | 'state' | 'outcome' | 'archived_at'>

// The proposals some tasks came from, looked up BY ID: a task's origin stays
// resolvable whether its proposal is live, archived, rejected or on a screen that
// never loaded the proposal list. Chunked so a long id list cannot overflow a URL.
export function useSourceProposals(ids: readonly string[]): UseQueryResult<Map<string, SourceProposal>, Error> {
  const seasonId = useSeasonId()
  const sorted = [...new Set(ids)].sort()
  return useQuery({
    queryKey: queryKeys.sourceProposals(seasonId, sorted),
    enabled: Boolean(seasonId) && sorted.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const map = new Map<string, SourceProposal>()
      for (const part of chunks(sorted)) {
        const { data, error } = await supabase
          .from('task_proposals')
          .select('id, title, state, outcome, archived_at')
          .in('id', part)
        if (error) throw new DataError('load the proposals these tasks came from', error)
        for (const row of data ?? []) map.set(row.id, row)
      }
      return map
    },
  })
}

export type SourcedTask = Pick<Task, 'id' | 'title' | 'source_proposal' | 'archived_at'>

// The reverse: the task each of these proposals produced, active or archived.
export function useTasksBySource(proposalIds: readonly string[]): UseQueryResult<Map<string, SourcedTask>, Error> {
  const seasonId = useSeasonId()
  const sorted = [...new Set(proposalIds)].sort()
  return useQuery({
    queryKey: queryKeys.tasksBySource(seasonId, sorted),
    enabled: Boolean(seasonId) && sorted.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const map = new Map<string, SourcedTask>()
      for (const part of chunks(sorted)) {
        const { data, error } = await supabase
          .from('tasks')
          .select('id, title, source_proposal, archived_at')
          .eq('season_id', seasonId as string)
          .in('source_proposal', part)
        if (error) throw new DataError('load the tasks these proposals produced', error)
        for (const row of data ?? []) if (row.source_proposal) map.set(row.source_proposal, row)
      }
      return map
    },
  })
}

export type TaskRequirementLink = { task_id: string; clause_key: string }

// Which requirements each task cites, for the whole season including archived
// tasks (the archive shows counts too). Read once, not per card.
export function useTaskRequirements(): UseQueryResult<TaskRequirementLink[], Error> {
  const seasonId = useSeasonId()
  return useQuery({
    queryKey: queryKeys.taskRequirements(seasonId),
    enabled: Boolean(seasonId),
    queryFn: async () => {
      const rows = await fetchAllRows(
        'load task requirements',
        (row: TaskRequirementLink) => `${row.task_id}|${row.clause_key}`,
        (from, to) =>
          supabase
            .from('task_requirements')
            .select('task_id, clause_key, tasks!inner(season_id)')
            .eq('tasks.season_id', seasonId as string)
            .order('task_id')
            .order('clause_key')
            .range(from, to),
      )
      return rows.map((r) => ({ task_id: r.task_id, clause_key: r.clause_key }))
    },
  })
}

// The columns progress needs, and nothing else — every task of the season,
// archived or not, so an archived DONE task still counts as complete and an
// archived unfinished one stays in the denominator (ADR-0006).
// What progress AND the Register's linked-task lists need to know about a task,
// archived or not. The title, priority, owner and department are for the
// Register's expandable list; the counting only reads id, state and archived_at.
export type ProgressTask = Pick<
  Task,
  | 'id'
  | 'state'
  | 'archived_at'
  | 'section_id'
  | 'milestone_key'
  | 'title'
  | 'priority'
  | 'owner_id'
  | 'subteam_key'
>

export type ProgressTasks = { data: ProgressTask[] | undefined; isLoading: boolean; error: Error | null }

export function useTasksForProgress(): ProgressTasks {
  const seasonId = useSeasonId()
  const active = useTasksForSeason(seasonId)
  const archived = useQuery({
    queryKey: queryKeys.progressTasks(seasonId),
    enabled: Boolean(seasonId),
    queryFn: () =>
      fetchAllRows(
        'load archived task progress',
        (row: ProgressTask) => row.id,
        (from, to) =>
          supabase
            .from('tasks')
            .select('id, state, archived_at, section_id, milestone_key, title, priority, owner_id, subteam_key')
            .eq('season_id', seasonId as string)
            .not('archived_at', 'is', null)
            .order('id')
            .range(from, to),
      ),
  })
  const data = active.data && archived.data ? [...(active.data as ProgressTask[]), ...archived.data] : undefined
  return { data, isLoading: active.isLoading || archived.isLoading, error: active.error ?? archived.error }
}
