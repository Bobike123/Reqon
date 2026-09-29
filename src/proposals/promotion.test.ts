import { describe, expect, it } from 'vitest'
import { describeBlockers, draftFrom, promotionBlockers } from './promotion.ts'

const complete = { subteam_key: 'AERO', due_date: '2026-12-01', milestone_key: 'MS1' }

describe('promotionBlockers', () => {
  it('has none for a complete proposal with a requirement', () => {
    expect(promotionBlockers(draftFrom(complete, 1))).toEqual([])
  })
  it('names every missing field, in a stable order', () => {
    expect(promotionBlockers(draftFrom({ subteam_key: null, due_date: null, milestone_key: null }, 0))).toEqual([
      'department', 'deadline', 'milestone', 'requirements',
    ])
  })
  it('names just the one thing that is missing', () => {
    expect(promotionBlockers(draftFrom(complete, 0))).toEqual(['requirements'])
    expect(promotionBlockers(draftFrom({ ...complete, due_date: null }, 2))).toEqual(['deadline'])
  })
})

describe('describeBlockers', () => {
  it('reads as a sentence fragment', () => {
    expect(describeBlockers([])).toBe('')
    expect(describeBlockers(['deadline'])).toBe('a deadline')
    expect(describeBlockers(['deadline', 'requirements'])).toBe('a deadline and at least one requirement')
    expect(describeBlockers(['department', 'deadline', 'milestone'])).toBe('a department, a deadline and a milestone')
  })
})
