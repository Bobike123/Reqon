import { describe, expect, it } from 'vitest'
import { TASK_CREATION_STATES, TASK_STATES, TASK_STATE_BOARD_TONE, TASK_STATE_GANTT_TONE, TASK_STATE_LABEL } from './taskState.ts'
import type { TaskState } from './types.ts'

const ALL_STATES: TaskState[] = ['todo', 'wip', 'blocked', 'done', 'cancelled']

describe('TASK_STATES', () => {
  it('covers exactly the five task_state enum values, once each', () => {
    expect(TASK_STATES.map((m) => m.state).sort()).toEqual([...ALL_STATES].sort())
  })

  it('does not carry urgent as a state — it is a priority now (ADR-0004)', () => {
    expect(TASK_STATES.map((m) => m.state)).not.toContain('urgent')
  })

  it('gives every state a unique board-lane order', () => {
    const orders = TASK_STATES.map((m) => m.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('marks only the states a promotion may start in as creation-eligible', () => {
    expect(TASK_CREATION_STATES.map((m) => m.state).sort()).toEqual(['todo', 'wip'])
    expect(TASK_CREATION_STATES.every((m) => m.creationEligible)).toBe(true)
  })

  it('every derived map covers all six states', () => {
    for (const state of ALL_STATES) {
      expect(TASK_STATE_LABEL[state]).toBeTruthy()
      expect(TASK_STATE_BOARD_TONE[state]).toBeTruthy()
      expect(TASK_STATE_GANTT_TONE[state]).toBeTruthy()
    }
  })
})
