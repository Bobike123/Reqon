import { describe, expect, it } from 'vitest'
import type { Milestone, MilestoneSection } from '../../data/useMilestones.ts'
import { draftedCount, sectionsFor, submissionWindow } from './milestoneModel.ts'

const TODAY = new Date('2026-09-09T12:00:00Z')

function ms(over: Partial<Milestone> & { key: string }): Milestone {
  return {
    key: over.key, season_id: 's', ordinal: over.ordinal ?? 1, name: over.key,
    aim: null, article_ref: null, opens_on: over.opens_on ?? null,
    due_on: over.due_on ?? null, max_points: over.max_points ?? 0,
    is_blocking: over.is_blocking ?? false, notes: null,
  } as Milestone
}
function section(key: string, ordinal: number, drafted: boolean): MilestoneSection {
  return { id: `${key}-${ordinal}`, milestone_key: key, ordinal, name: `Section ${ordinal}`,
    is_drafted: drafted, owner_id: null, updated_at: '' } as MilestoneSection
}

describe('submission window', () => {
  it('renders TBC when due_on is null — never a synthesized date', () => {
    // MS1-7 happens at the Final Event and has no published window.
    const w = submissionWindow(ms({ key: 'MS1-7', due_on: null, max_points: 60 }), TODAY)
    expect(w.kind).toBe('tbc')
    expect(JSON.stringify(w)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('reports the real window and days remaining when a date exists', () => {
    const w = submissionWindow(
      ms({ key: 'MS1-1', opens_on: '2026-11-01', due_on: '2026-11-30' }), TODAY,
    )
    expect(w).toEqual({
      kind: 'dated', opensOn: '2026-11-01', dueOn: '2026-11-30',
      daysRemaining: 82, passed: false,
    })
  })

  it('marks a window that has already closed', () => {
    const w = submissionWindow(ms({ key: 'OLD', due_on: '2026-08-01' }), TODAY)
    expect(w.kind === 'dated' && w.passed).toBe(true)
    expect(w.kind === 'dated' && w.daysRemaining).toBeLessThan(0)
  })
})

describe('sections', () => {
  const all = [
    section('MS1-2', 2, true), section('MS1-1', 1, false),
    section('MS1-1', 2, true), section('MS1-1', 3, false),
  ]

  it('picks only this milestone\'s sections, in book order', () => {
    expect(sectionsFor(all, 'MS1-1').map((s) => s.ordinal)).toEqual([1, 2, 3])
  })

  it('counts drafted against total', () => {
    expect(draftedCount(sectionsFor(all, 'MS1-1'))).toEqual({ drafted: 1, total: 3 })
    expect(draftedCount([])).toEqual({ drafted: 0, total: 0 })
  })
})
