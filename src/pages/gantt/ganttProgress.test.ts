import { describe, expect, it } from 'vitest'
import type { MilestoneSection } from '../../milestones/types.ts'
import {
  lensProgress,
  milestoneProgress,
  progressLabel,
  sectionProgress,
  tasksUnderSection,
  unsectionedFor,
  type ProgressRow,
} from './ganttProgress.ts'

const sec = (id: string, drafted = false): MilestoneSection =>
  ({ id, milestone_key: 'M1', ordinal: 1, name: id, is_drafted: drafted, owner_id: null, updated_at: '' }) as MilestoneSection

function row(id: string, over: Partial<ProgressRow> = {}): ProgressRow {
  return { id, state: 'todo', archived_at: null, section_id: null, milestone_key: 'M1', owner_id: null, subteam_key: 'AERO', ...over }
}
const ARCHIVED = '2026-10-01T00:00:00Z'

describe('milestoneProgress: one rule, counted once', () => {
  const sections = [sec('s1'), sec('s2')]

  it('counts sectioned and unsectioned work under a milestone, each task once', () => {
    const tasks = [
      row('a', { state: 'done', section_id: 's1' }),
      row('b', { section_id: 's2' }),
      row('c', { state: 'done' }), // unsectioned, milestone_key = M1
      row('d', { milestone_key: 'M2' }), // another milestone
    ]
    expect(milestoneProgress(sections, tasks, 'M1')).toMatchObject({ basis: 'tasks', done: 2, total: 3, percent: 67 })
  })

  it('does not double count a task that appears in both the active and archived lists', () => {
    const one = row('a', { state: 'done', section_id: 's1' })
    expect(milestoneProgress(sections, [one, { ...one }], 'M1')).toMatchObject({ done: 1, total: 1, percent: 100 })
  })

  it('leaves cancelled work out of both sides', () => {
    const tasks = [row('a', { state: 'done' }), row('b', { state: 'cancelled' })]
    expect(milestoneProgress(sections, tasks, 'M1')).toMatchObject({ done: 1, total: 1, percent: 100 })
  })

  it('archiving a Done task does not lower progress: archived Done still counts as done', () => {
    const active = [row('a', { state: 'done' }), row('b')]
    const afterArchive = [row('a', { state: 'done', archived_at: ARCHIVED }), row('b')]
    expect(milestoneProgress(sections, active, 'M1').percent).toBe(50)
    expect(milestoneProgress(sections, afterArchive, 'M1').percent).toBe(50)
    expect(milestoneProgress(sections, afterArchive, 'M1')).toMatchObject({ archivedDone: 1 })
  })

  it('an archived task that never finished stays in the denominator and is reported', () => {
    const view = milestoneProgress(sections, [row('a', { state: 'done' }), row('b', { state: 'wip', archived_at: ARCHIVED })], 'M1')
    expect(view).toMatchObject({ done: 1, total: 2, percent: 50, archivedUnfinished: 1 })
  })

  it('with no linked task, the drafted checklist stands in and is labelled as drafted', () => {
    const view = milestoneProgress([sec('s1', true), sec('s2')], [], 'M1')
    expect(view).toMatchObject({ basis: 'drafted', percent: 50, done: 1, total: 2 })
    expect(progressLabel(view)).toBe('1 of 2 sections drafted (no tasks linked)')
  })

  it('with nothing at all it says so, and has no percentage', () => {
    const view = milestoneProgress([], [], 'M1')
    expect(view).toMatchObject({ basis: 'none', percent: null })
    expect(progressLabel(view)).toBe('No linked work')
  })

  it('once a task is linked the drafted ticks stop counting', () => {
    expect(milestoneProgress([sec('s1', true)], [row('a')], 'M1')).toMatchObject({ basis: 'tasks', percent: 0 })
  })
})

describe('sectionProgress', () => {
  it('counts the section\'s tasks including archived Done work', () => {
    const view = sectionProgress(sec('s1'), [row('a', { state: 'done', section_id: 's1', archived_at: ARCHIVED }), row('b', { section_id: 's1' })])
    expect(view).toMatchObject({ basis: 'tasks', done: 1, total: 2, percent: 50 })
  })

  it('a section with no task shows its own drafted tick, labelled', () => {
    expect(progressLabel(sectionProgress(sec('s1', true), []), 'section')).toBe('Drafted (no tasks linked)')
    expect(progressLabel(sectionProgress(sec('s1', false), []), 'section')).toBe('Not drafted (no tasks linked)')
    expect(sectionProgress(sec('s1', true), [])).toMatchObject({ basis: 'drafted', percent: 100 })
  })
})

describe('lensProgress: the department figure, beside the overall one', () => {
  const sections = [sec('s1')]
  const all = [
    row('a', { state: 'done', subteam_key: 'AERO', section_id: 's1' }),
    row('b', { subteam_key: 'BODY', section_id: 's1' }),
    row('c', { subteam_key: 'BODY', state: 'done' }),
  ]

  it('counts only the tasks the lens lets through, with the same rule', () => {
    const body = all.filter((t) => t.subteam_key === 'BODY')
    expect(lensProgress(sections, body, 'M1')).toMatchObject({ basis: 'tasks', done: 1, total: 2, percent: 50 })
  })

  it('does not move the overall figure', () => {
    const overall = milestoneProgress(sections, all, 'M1')
    lensProgress(sections, all.filter((t) => t.subteam_key === 'AERO'), 'M1')
    expect(milestoneProgress(sections, all, 'M1')).toEqual(overall)
    expect(overall).toMatchObject({ done: 2, total: 3 })
  })

  it('never falls back to the drafted checklist: no work for the department is "no linked work"', () => {
    const view = lensProgress([sec('s1', true)], [], 'M1')
    expect(view).toMatchObject({ basis: 'none', percent: null })
  })
})

describe('progressLabel', () => {
  it('always says what it counts, including archived work', () => {
    expect(progressLabel({ basis: 'tasks', percent: 50, done: 3, total: 6, archivedDone: 2, archivedUnfinished: 1 })).toBe(
      '3 of 6 tasks done, incl. 2 archived done, 1 archived unfinished',
    )
    expect(progressLabel({ basis: 'tasks', percent: 100, done: 1, total: 1, archivedDone: 0, archivedUnfinished: 0 })).toBe('1 of 1 tasks done')
  })
})

describe('groups', () => {
  it('unsectionedFor finds work on a milestone with no section, and no fake section is involved', () => {
    const tasks = [row('a'), row('b', { section_id: 's1' }), row('c', { milestone_key: 'M2' }), row('d', { milestone_key: null })]
    expect(unsectionedFor(tasks, 'M1').map((t) => t.id)).toEqual(['a'])
  })

  it('tasksUnderSection', () => {
    expect(tasksUnderSection([row('a', { section_id: 's1' }), row('b')], 's1').map((t) => t.id)).toEqual(['a'])
  })
})
