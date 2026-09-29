import { describe, expect, it } from 'vitest'
import {
  indexLinkedWork,
  linkedWorkFor,
  offersMarkCompliant,
  progressDetail,
  progressHeadline,
  type LinkedTask,
} from './linkedWork.ts'

function task(id: string, over: Partial<LinkedTask> = {}): LinkedTask {
  return { id, title: id, state: 'todo', priority: 'normal', owner_id: null, subteam_key: null, archived_at: null, ...over }
}

describe('indexLinkedWork', () => {
  it('shows one requirement with many tasks, and one task under many requirements', () => {
    const tasks = [task('a', { state: 'done' }), task('b'), task('c')]
    const index = indexLinkedWork(
      [
        { task_id: 'a', clause_key: 'R1' },
        { task_id: 'b', clause_key: 'R1' },
        { task_id: 'a', clause_key: 'R2' },
        { task_id: 'c', clause_key: 'R2' },
      ],
      tasks,
    )
    expect(linkedWorkFor(index, 'R1').tasks.map((t) => t.id).sort()).toEqual(['a', 'b'])
    expect(linkedWorkFor(index, 'R2').tasks.map((t) => t.id).sort()).toEqual(['a', 'c'])
    // Task "a" is counted once in EACH requirement it serves.
    expect(linkedWorkFor(index, 'R1').progress).toMatchObject({ done: 1, total: 2 })
    expect(linkedWorkFor(index, 'R2').progress).toMatchObject({ done: 1, total: 2 })
  })

  it('ignores a repeated link row so a task is never counted twice', () => {
    const index = indexLinkedWork(
      [
        { task_id: 'a', clause_key: 'R1' },
        { task_id: 'a', clause_key: 'R1' },
      ],
      [task('a', { state: 'done' })],
    )
    expect(linkedWorkFor(index, 'R1').progress).toMatchObject({ done: 1, total: 1 })
  })

  it('reports linked tasks it cannot see rather than counting them as work', () => {
    const index = indexLinkedWork([{ task_id: 'ghost', clause_key: 'R1' }], [])
    const work = linkedWorkFor(index, 'R1')
    expect(work.unknown).toBe(1)
    expect(work.progress.total).toBe(0)
    expect(progressDetail(work)).toMatch(/could not be loaded/)
  })

  it('a requirement with no links is "No linked work"', () => {
    const work = linkedWorkFor(new Map(), 'R9')
    expect(progressHeadline(work.progress)).toBe('No linked work')
    expect(work.progress.percent).toBeNull()
  })

  it('lists unfinished live work first, then finished, then archived, then cancelled', () => {
    const index = indexLinkedWork(
      ['a', 'b', 'c', 'd'].map((id) => ({ task_id: id, clause_key: 'R1' })),
      [
        task('a', { title: 'a-cancelled', state: 'cancelled' }),
        task('b', { title: 'b-archived', state: 'done', archived_at: '2026-09-01T00:00:00Z' }),
        task('c', { title: 'c-done', state: 'done' }),
        task('d', { title: 'd-wip', state: 'wip' }),
      ],
    )
    expect(linkedWorkFor(index, 'R1').tasks.map((t) => t.title)).toEqual(['d-wip', 'c-done', 'b-archived', 'a-cancelled'])
  })

  it('links survive a state change and archiving: the same tasks stay listed', () => {
    const links = [{ task_id: 'a', clause_key: 'R1' }]
    const before = linkedWorkFor(indexLinkedWork(links, [task('a', { state: 'wip' })]), 'R1')
    const after = linkedWorkFor(
      indexLinkedWork(links, [task('a', { state: 'done', archived_at: '2026-09-01T00:00:00Z' })]),
      'R1',
    )
    expect(before.tasks.map((t) => t.id)).toEqual(['a'])
    expect(after.tasks.map((t) => t.id)).toEqual(['a'])
    expect(after.progress).toMatchObject({ done: 1, total: 1 })
  })
})

describe('progressHeadline', () => {
  it('is singular for one task', () => {
    expect(progressHeadline({ done: 0, total: 1, percent: 0, archivedUnfinished: 0 })).toBe('0 / 1 linked task done')
    expect(progressHeadline({ done: 2, total: 3, percent: 67, archivedUnfinished: 0 })).toBe('2 / 3 linked tasks done')
  })
})

describe('offersMarkCompliant', () => {
  const done = (n: number) => linkedWorkFor(
    indexLinkedWork(
      Array.from({ length: n }, (_, i) => ({ task_id: `t${i}`, clause_key: 'R' })),
      Array.from({ length: n }, (_, i) => task(`t${i}`, { state: 'done' })),
    ),
    'R',
  )

  it('offers it only when there is work and all of it is done', () => {
    expect(offersMarkCompliant('open', done(2))).toBe(true)
    expect(offersMarkCompliant('wip', done(1))).toBe(true)
    expect(offersMarkCompliant('blocked', done(1))).toBe(true)
    expect(offersMarkCompliant('open', done(0))).toBe(false)
  })

  it('never offers it for a requirement already decided', () => {
    for (const state of ['compliant', 'verified', 'na'] as const) expect(offersMarkCompliant(state, done(1))).toBe(false)
  })

  it('does not offer it while any counted task is unfinished', () => {
    const work = linkedWorkFor(
      indexLinkedWork(
        [{ task_id: 'a', clause_key: 'R' }, { task_id: 'b', clause_key: 'R' }],
        [task('a', { state: 'done' }), task('b', { state: 'wip' })],
      ),
      'R',
    )
    expect(offersMarkCompliant('open', work)).toBe(false)
  })

  it('cancelled work does not block the offer, and does not satisfy it alone', () => {
    const mixed = linkedWorkFor(
      indexLinkedWork(
        [{ task_id: 'a', clause_key: 'R' }, { task_id: 'c', clause_key: 'R' }],
        [task('a', { state: 'done' }), task('c', { state: 'cancelled' })],
      ),
      'R',
    )
    expect(offersMarkCompliant('open', mixed)).toBe(true)
    const onlyCancelled = linkedWorkFor(
      indexLinkedWork([{ task_id: 'c', clause_key: 'R' }], [task('c', { state: 'cancelled' })]),
      'R',
    )
    expect(offersMarkCompliant('open', onlyCancelled)).toBe(false)
  })
})
