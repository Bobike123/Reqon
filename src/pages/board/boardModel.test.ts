import { describe, expect, it } from 'vitest'
import { isOverdue } from './boardModel.ts'

const TODAY = '2026-09-09'

describe('isOverdue', () => {
  it('is true for a past due date on open work', () => {
    expect(isOverdue({ due_date: '2026-09-08', state: 'todo' }, TODAY)).toBe(true)
  })

  it('is false for a due date that is today or in the future', () => {
    expect(isOverdue({ due_date: '2026-09-09', state: 'todo' }, TODAY)).toBe(false)
    expect(isOverdue({ due_date: '2026-09-10', state: 'todo' }, TODAY)).toBe(false)
  })

  it('is false with no due date at all', () => {
    expect(isOverdue({ due_date: null, state: 'todo' }, TODAY)).toBe(false)
  })

  it('is false once the task is done or cancelled, however late it is', () => {
    expect(isOverdue({ due_date: '2026-01-01', state: 'done' }, TODAY)).toBe(false)
    expect(isOverdue({ due_date: '2026-01-01', state: 'cancelled' }, TODAY)).toBe(false)
  })

  it('is true across every other open state', () => {
    for (const state of ['todo', 'wip', 'blocked'] as const) {
      expect(isOverdue({ due_date: '2026-09-08', state }, TODAY)).toBe(true)
    }
  })
})
