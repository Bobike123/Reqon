import { describe, expect, it } from 'vitest'
import { isUrgent, TASK_PRIORITIES, TASK_PRIORITY_BADGE_TONE, TASK_PRIORITY_LABEL } from './priority.ts'

describe('TASK_PRIORITIES', () => {
  it('covers exactly the two task_priority enum values', () => {
    expect([...TASK_PRIORITIES].sort()).toEqual(['normal', 'urgent'])
  })

  it('gives every priority a label', () => {
    for (const p of TASK_PRIORITIES) {
      expect(TASK_PRIORITY_LABEL[p]).toBeTruthy()
    }
  })

  it('only urgent gets a badge tone — normal renders nothing', () => {
    expect(TASK_PRIORITY_BADGE_TONE.normal).toBe('')
    expect(TASK_PRIORITY_BADGE_TONE.urgent).not.toBe('')
  })
})

describe('isUrgent', () => {
  it('is true only for urgent', () => {
    expect(isUrgent('urgent')).toBe(true)
    expect(isUrgent('normal')).toBe(false)
  })
})
