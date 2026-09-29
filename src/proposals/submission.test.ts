import { describe, expect, it } from 'vitest'
import { submissionProblems, type NewProposal } from './submission.ts'

const complete: NewProposal = {
  title: 'Mount the rear wing',
  departmentKey: 'AERO',
  dueDate: '2026-12-01',
  milestoneKey: 'MS1-1',
  requirementKeys: ['A.1.1.1'],
}

describe('submissionProblems', () => {
  it('accepts a complete proposal', () => {
    expect(submissionProblems(complete)).toEqual([])
  })

  it.each<[string, Partial<NewProposal>]>([
    ['title', { title: '   ' }],
    ['title', { title: 'x'.repeat(201) }],
    ['department', { departmentKey: '' }],
    ['dueDate', { dueDate: '' }],
    ['dueDate', { dueDate: '2026-13-45' }],
    ['dueDate', { dueDate: '2026-12-01T10:00:00Z' }],
    ['milestone', { milestoneKey: '' }],
    ['requirement', { requirementKeys: [] }],
  ])('names the missing %s', (problem, override) => {
    expect(submissionProblems({ ...complete, ...override })).toEqual([problem])
  })

  it('reports every missing field at once', () => {
    expect(submissionProblems({})).toEqual(['title', 'department', 'dueDate', 'milestone', 'requirement'])
  })
})
