import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from './queryKeys.ts'

// The contract behind "link changes and deadline edits refresh the right
// screens": what a link/unlink actually sends, and which season's caches a task
// edit or a milestone date edit invalidates — this season's timeline, progress
// and attention (Now), and nothing belonging to another season.

const writes: { table: string; payload: Record<string, unknown> }[] = []
const supabase = {
  from: (table: string) => ({
    update: (payload: Record<string, unknown>) => {
      writes.push({ table, payload })
      return { eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'x', key: 'x' }], error: null }) }) }
    },
  }),
  rpc: () => Promise.resolve({ data: true, error: null }),
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 'season-a' }))

const { useUpdateTask } = await import('./useTasks.ts')
const { useUpdateMilestone } = await import('./useMilestones.ts')

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const result = renderHook(useHook, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  }).result
  const invalidated = () => invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown[] }).queryKey))
  return { result, invalidated }
}

beforeEach(() => {
  writes.length = 0
})

describe('a task link change', () => {
  it('a link sends milestone and section together in ONE update', async () => {
    const { result } = setup(() => useUpdateTask())
    await result.current.mutateAsync({ id: 't1', sectionId: 'sec1', milestoneKey: 'MS1-1' })
    expect(writes).toEqual([{ table: 'tasks', payload: { section_id: 'sec1', milestone_key: 'MS1-1' } }])
  })

  it('unlinking a section sends only the section, so the milestone stays', async () => {
    const { result } = setup(() => useUpdateTask())
    await result.current.mutateAsync({ id: 't1', sectionId: null })
    expect(writes[0].payload).toEqual({ section_id: null })
    expect('milestone_key' in writes[0].payload).toBe(false)
  })

  it('refreshes this season\'s tasks, progress and attention (Now) once settled — and only this season\'s', async () => {
    const { result, invalidated } = setup(() => useUpdateTask())
    await result.current.mutateAsync({ id: 't1', sectionId: 'sec1', milestoneKey: 'MS1-1' })
    await waitFor(() => expect(invalidated()).toContain(JSON.stringify(queryKeys.attention('season-a'))))
    const keys = invalidated()
    expect(keys).toContain(JSON.stringify(queryKeys.tasks('season-a')))
    expect(keys).toContain(JSON.stringify(queryKeys.progressTasks('season-a')))
    for (const key of keys) expect(key).toContain('season-a')
    expect(keys.join('|')).not.toContain('season-b')
  })
})

describe('a milestone date edit', () => {
  it('refreshes this season\'s timeline and Now, and no other season\'s', async () => {
    const { result, invalidated } = setup(() => useUpdateMilestone())
    await result.current.mutateAsync({ key: 'MS1-1', dueOn: '2026-12-05' })
    await waitFor(() => expect(invalidated()).toContain(JSON.stringify(queryKeys.milestones('season-a'))))
    expect(invalidated()).toContain(JSON.stringify(queryKeys.attention('season-a')))
    for (const key of invalidated()) expect(key).toContain('season-a')
  })

  it('sends only the dates that were edited', async () => {
    const { result } = setup(() => useUpdateMilestone())
    await result.current.mutateAsync({ key: 'MS1-1', opensOn: null })
    expect(writes[0]).toEqual({ table: 'milestones', payload: { opens_on: null } })
  })
})
