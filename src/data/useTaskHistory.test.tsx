import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The history reads in isolation: which filters reach the database (so paging and
// filtering happen there, not in the browser), the search escaping, past-the-end
// pages, chunked id lookups, and the progress list that includes archived work.

type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null }
let calls: { table: string; ops: [string, ...unknown[]][] }[]
let results: (table: string, ops: [string, ...unknown[]][]) => Result

function builder(table: string) {
  const record = { table, ops: [] as [string, ...unknown[]][] }
  calls.push(record)
  const b: Record<string, unknown> = {}
  for (const name of ['select', 'eq', 'not', 'is', 'in', 'or', 'ilike', 'order', 'range']) {
    b[name] = (...args: unknown[]) => {
      record.ops.push([name, ...args])
      return b
    }
  }
  b.then = (resolve: (v: unknown) => void) => {
    resolve(results(table, record.ops))
    return Promise.resolve()
  }
  return b
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return { from: builder } } }))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 'season-a' }))
vi.mock('./useTasks.ts', () => ({
  useTasksForSeason: () => ({ data: [{ id: 'active-1', state: 'wip', archived_at: null, section_id: null, milestone_key: null }], isLoading: false, error: null }),
}))

const { useArchivedTasks, useProposalHistory, useSourceProposals, useTasksBySource, useTaskRequirements, useTasksForProgress, likePattern, ARCHIVE_PAGE_SIZE, NO_DEPARTMENT } =
  await import('./useTaskHistory.ts')

function hook<T>(use: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(use, { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
}
const has = (ops: [string, ...unknown[]][], name: string, ...args: unknown[]) =>
  ops.some((o) => o[0] === name && args.every((a, i) => JSON.stringify(o[i + 1]) === JSON.stringify(a)))

// fetchAllRows pages until an empty page; a fake must answer only the first.
const firstPageOnly = (rows: unknown[]) => (_t: string, ops: [string, ...unknown[]][]): Result => {
  const from = (ops.find((o) => o[0] === 'range')?.[1] as number | undefined) ?? 0
  return { data: from === 0 ? rows : [], error: null }
}

const base = { department: '', owner: '', state: '', search: '', id: '', page: 0 }

beforeEach(() => {
  calls = []
  results = () => ({ data: [], error: null, count: 0 })
})

describe('likePattern', () => {
  it('escapes the user\'s own wildcards so 50% means fifty percent', () => {
    expect(likePattern(' 50%_off ')).toBe('%50\\%\\_off%')
    expect(likePattern('a\\b')).toBe('%a\\\\b%')
  })
})

describe('useArchivedTasks', () => {
  it('asks the database for this season\'s archived tasks only, newest first, one page at a time', async () => {
    results = () => ({ data: [{ id: 't1' }], error: null, count: 60 })
    const { result } = hook(() => useArchivedTasks({ ...base, page: 2 }))
    await waitFor(() => expect(result.current.data).toBeTruthy())
    expect(result.current.data).toEqual({ rows: [{ id: 't1' }], total: 60 })
    const ops = calls[0].ops
    expect(has(ops, 'eq', 'season_id', 'season-a')).toBe(true)
    expect(has(ops, 'not', 'archived_at', 'is', null)).toBe(true)
    expect(has(ops, 'order', 'archived_at', { ascending: false })).toBe(true)
    expect(has(ops, 'range', 2 * ARCHIVE_PAGE_SIZE, 2 * ARCHIVE_PAGE_SIZE + ARCHIVE_PAGE_SIZE - 1)).toBe(true)
  })

  it('pushes every filter into the query, escaping the search text', async () => {
    const { result } = hook(() => useArchivedTasks({ department: 'AERO', owner: 'm1', state: 'done', search: '50%', id: '', page: 0 }))
    await waitFor(() => expect(result.current.data).toBeTruthy())
    const ops = calls[0].ops
    expect(has(ops, 'eq', 'subteam_key', 'AERO')).toBe(true)
    expect(has(ops, 'eq', 'owner_id', 'm1')).toBe(true)
    expect(has(ops, 'eq', 'state', 'done')).toBe(true)
    expect(has(ops, 'ilike', 'title', '%50\\%%')).toBe(true)
  })

  it('treats "no department" as older work with no department, and an id as exactly one task', async () => {
    const { result } = hook(() => useArchivedTasks({ ...base, department: NO_DEPARTMENT, id: 'task-9' }))
    await waitFor(() => expect(result.current.data).toBeTruthy())
    expect(has(calls[0].ops, 'is', 'subteam_key', null)).toBe(true)
    expect(has(calls[0].ops, 'eq', 'id', 'task-9')).toBe(true)
  })

  it('treats a page past the end as an empty page, not a failure', async () => {
    results = () => ({ data: null, error: { message: 'range not satisfiable', code: 'PGRST103' }, count: 3 })
    const { result } = hook(() => useArchivedTasks({ ...base, page: 9 }))
    await waitFor(() => expect(result.current.data).toEqual({ rows: [], total: 3 }))
  })

  it('surfaces a real error', async () => {
    results = () => ({ data: null, error: { message: 'boom', code: '500' }, count: null })
    const { result } = hook(() => useArchivedTasks(base))
    await waitFor(() => expect(result.current.error?.message).toMatch(/archived tasks/))
  })
})

describe('useProposalHistory', () => {
  it('reads only proposals that are archived or decided, and maps status to the recorded outcome', async () => {
    const approved = hook(() => useProposalHistory({ ...base, status: 'approved' }))
    await waitFor(() => expect(approved.result.current.data).toBeTruthy())
    expect(has(calls[0].ops, 'or', 'archived_at.not.is.null,state.eq.decided')).toBe(true)
    expect(has(calls[0].ops, 'eq', 'outcome', 'approved')).toBe(true)

    calls = []
    const other = hook(() => useProposalHistory({ ...base, status: 'other' }))
    await waitFor(() => expect(other.result.current.data).toBeTruthy())
    expect(has(calls[0].ops, 'is', 'outcome', null)).toBe(true)
  })
})

describe('provenance lookups are by id and chunked', () => {
  it('looks up source proposals by id, forty at a time, so a long list cannot overflow a URL', async () => {
    const ids = Array.from({ length: 85 }, (_, i) => `p${String(i).padStart(3, '0')}`)
    results = (_t, ops) => ({ data: ((ops.find((o) => o[0] === 'in')?.[2] as string[]) ?? []).map((id) => ({ id, title: `T ${id}` })), error: null })
    const { result } = hook(() => useSourceProposals(ids))
    await waitFor(() => expect(result.current.data?.size).toBe(85))
    expect(calls.filter((c) => c.table === 'task_proposals')).toHaveLength(3)
    expect(result.current.data?.get('p084')?.title).toBe('T p084')
  })

  it('asks nothing when there is nothing to look up', () => {
    hook(() => useSourceProposals([]))
    expect(calls).toHaveLength(0)
  })

  it('finds the task each proposal produced, archived or not', async () => {
    results = () => ({ data: [{ id: 't1', title: 'Task', source_proposal: 'p1', archived_at: '2026-09-01' }], error: null })
    const { result } = hook(() => useTasksBySource(['p1']))
    await waitFor(() => expect(result.current.data?.get('p1')?.title).toBe('Task'))
    expect(has(calls[0].ops, 'eq', 'season_id', 'season-a')).toBe(true)
  })
})

describe('requirement links and progress', () => {
  it('reads the season\'s task requirement links through the tasks relationship', async () => {
    results = firstPageOnly([{ task_id: 't1', clause_key: 'A.1', tasks: { season_id: 'season-a' } }])
    const { result } = hook(() => useTaskRequirements())
    await waitFor(() => expect(result.current.data).toEqual([{ task_id: 't1', clause_key: 'A.1' }]))
    expect(has(calls[0].ops, 'eq', 'tasks.season_id', 'season-a')).toBe(true)
  })

  it('progress covers active AND archived tasks, so archived Done work still counts', async () => {
    results = firstPageOnly([{ id: 'arch-1', state: 'done', archived_at: '2026-09-01', section_id: null, milestone_key: 'MS1' }])
    const { result } = hook(() => useTasksForProgress())
    await waitFor(() => expect(result.current.data?.map((t) => t.id)).toEqual(['active-1', 'arch-1']))
    expect(has(calls[0].ops, 'not', 'archived_at', 'is', null)).toBe(true)
  })
})
