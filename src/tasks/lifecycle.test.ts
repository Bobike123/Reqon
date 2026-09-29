import { describe, expect, it } from 'vitest'
import { archiveLabel, completionLabel, dueDateIsProtected, isArchived, isDone } from './lifecycle.ts'

describe('isArchived / isDone', () => {
  it('reads archived_at and state directly', () => {
    expect(isArchived({ archived_at: null })).toBe(false)
    expect(isArchived({ archived_at: '2026-09-01T00:00:00Z' })).toBe(true)
    expect(isDone({ state: 'done' })).toBe(true)
    expect(isDone({ state: 'wip' })).toBe(false)
  })
})

describe('completionLabel', () => {
  it('is null for a task that was never completed', () => {
    expect(completionLabel({ completed_at: null, completion_source: null })).toBeNull()
  })

  it('shows a plain "Completed" for a real recorded transition', () => {
    const label = completionLabel({ completed_at: '2026-09-01T12:00:00Z', completion_source: 'recorded' })
    expect(label).toMatch(/^Completed /)
    expect(label).not.toMatch(/exact time unknown/)
  })

  it('flags a migration-observed completion as inexact, never presented as exact', () => {
    const label = completionLabel({ completed_at: '2026-09-01T12:00:00Z', completion_source: 'migration_observed' })
    expect(label).toMatch(/^Completed before /)
    expect(label).toMatch(/exact time unknown/)
  })

  it('treats an activity-backfilled completion as a real (not inexact) instant', () => {
    const label = completionLabel({ completed_at: '2026-09-01T12:00:00Z', completion_source: 'activity_backfill' })
    expect(label).toMatch(/^Completed /)
    expect(label).not.toMatch(/exact time unknown/)
  })
})

describe('archiveLabel', () => {
  it('is null for an active task', () => {
    expect(archiveLabel({ archived_at: null, archive_reason: null })).toBeNull()
  })

  it('names the reason when known', () => {
    expect(archiveLabel({ archived_at: '2026-09-01T00:00:00Z', archive_reason: 'manual' })).toMatch(/^Archived manually/)
    expect(archiveLabel({ archived_at: '2026-09-01T00:00:00Z', archive_reason: 'auto_done_24h' })).toMatch(/^Archived automatically/)
  })

  it('falls back to a plain label when the reason is unset', () => {
    expect(archiveLabel({ archived_at: '2026-09-01T00:00:00Z', archive_reason: null })).toMatch(/^Archived \d/)
  })
})

describe('dueDateIsProtected', () => {
  it('is true only for a promoted task that still has a deadline', () => {
    expect(dueDateIsProtected({ source_proposal: 'p1', due_date: '2026-10-01' })).toBe(true)
    expect(dueDateIsProtected({ source_proposal: null, due_date: '2026-10-01' })).toBe(false)
    expect(dueDateIsProtected({ source_proposal: 'p1', due_date: null })).toBe(false)
  })
})
