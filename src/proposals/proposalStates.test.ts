import { describe, expect, it } from 'vitest'
import { isPromotable, proposalStatusLabel, reviewActionsFor } from './proposalStates.ts'

const stage = (state: 'open' | 'agenda' | 'changes_requested' | 'approved' | 'decided' | 'parked', outcome: 'approved' | 'rejected' | null = null, archived = false) => ({
  state,
  outcome,
  archived_at: archived ? '2026-09-23T00:00:00Z' : null,
})

describe('reviewActionsFor (mirrors review_proposal)', () => {
  it('offers review, park and reject on a suggested proposal', () => {
    expect(reviewActionsFor(stage('open'), false)).toEqual(['review', 'park', 'reject'])
  })
  it('offers park and reject once under review', () => {
    expect(reviewActionsFor(stage('agenda'), false)).toEqual(['park', 'reject'])
    expect(reviewActionsFor(stage('changes_requested'), false)).toEqual(['park', 'reject'])
    expect(reviewActionsFor(stage('approved'), false)).toEqual(['park', 'reject'])
  })
  it('offers only reopen for a parked or a rejected proposal', () => {
    expect(reviewActionsFor(stage('parked'), false)).toEqual(['reopen'])
    expect(reviewActionsFor(stage('decided', 'rejected', true), false)).toEqual(['reopen'])
  })
  it('offers reopen for a decided proposal whose outcome was never recorded', () => {
    expect(reviewActionsFor(stage('decided'), false)).toEqual(['reopen'])
  })
  it('offers nothing for an approved proposal or one that already has a task', () => {
    expect(reviewActionsFor(stage('decided', 'approved', true), true)).toEqual([])
    expect(reviewActionsFor(stage('decided'), true)).toEqual([])
  })
})

describe('proposalStatusLabel', () => {
  it('reports the outcome, and does not guess one that was never recorded', () => {
    expect(proposalStatusLabel(stage('decided', 'approved'))).toBe('Approved')
    expect(proposalStatusLabel(stage('decided', 'rejected'))).toBe('Rejected')
    expect(proposalStatusLabel(stage('decided'))).toBe('Decided (outcome not recorded)')
    expect(proposalStatusLabel(stage('agenda'))).toBe('Under review')
  })
})

describe('isPromotable', () => {
  it('is true only for a complete, unarchived, approved proposal', () => {
    const ok = { state: 'approved' as const, archived_at: null, legacy_incomplete: false }
    expect(isPromotable(ok)).toBe(true)
    expect(isPromotable({ ...ok, state: 'agenda' })).toBe(false)
    expect(isPromotable({ ...ok, state: 'open' })).toBe(false)
    expect(isPromotable({ ...ok, state: 'parked' })).toBe(false)
    expect(isPromotable({ ...ok, state: 'decided' })).toBe(false)
    expect(isPromotable({ ...ok, archived_at: '2026-09-23T00:00:00Z' })).toBe(false)
    expect(isPromotable({ ...ok, legacy_incomplete: true })).toBe(false)
  })
})
