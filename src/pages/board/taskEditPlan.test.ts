import { describe, expect, it } from 'vitest'
import { planScheduleEdit, planTaskEdit, type TaskFormValues } from './taskEditPlan.ts'

const TASK = {
  id: 't1', title: 'Weld the frame', detail: 'Jig first', starts_on: '2026-10-01', due_date: '2026-10-20',
  priority: 'normal' as const, milestone_key: 'MS1-2', owner_id: 'm1', links_required: false,
  state: 'todo' as const, blocked_reason: null as string | null,
}
const same: TaskFormValues = {
  title: TASK.title, detail: TASK.detail, start: TASK.starts_on, due: TASK.due_date, priority: 'normal', milestone: 'MS1-2', owner: 'm1', blockedReason: '',
}

describe('planTaskEdit', () => {
  it('sends nothing, and says so, when nothing changed', () => {
    expect(planTaskEdit(TASK, same, true)).toEqual({ kind: 'unchanged' })
    // Whitespace around the same title is not a change.
    expect(planTaskEdit(TASK, { ...same, title: '  Weld the frame ' }, true)).toEqual({ kind: 'unchanged' })
  })

  it('sends a cleared deadline as a real clear (null) — never drops it and claims "Saved" (F14-04)', () => {
    const plan = planTaskEdit(TASK, { ...same, due: '' }, true)
    expect(plan).toEqual({ kind: 'edit', edit: { id: 't1', dueDate: null }, changed: ['deadline removed'] })
  })

  it('clears a start date and a description the same way', () => {
    expect(planTaskEdit(TASK, { ...same, start: '', detail: '   ' }, true)).toEqual({
      kind: 'edit',
      edit: { id: 't1', detail: null, startsOn: null },
      changed: ['description cleared', 'start date removed'],
    })
  })

  it('edits the title, trimmed, and refuses an empty or over-long one', () => {
    expect(planTaskEdit(TASK, { ...same, title: ' Weld it ' }, true)).toMatchObject({ kind: 'edit', edit: { title: 'Weld it' } })
    expect(planTaskEdit(TASK, { ...same, title: '   ' }, true)).toEqual({ kind: 'invalid', reason: 'A task needs a title.' })
    expect(planTaskEdit(TASK, { ...same, title: 'x'.repeat(201) }, true).kind).toBe('invalid')
    expect(planTaskEdit(TASK, { ...same, title: 'x'.repeat(200) }, true).kind).toBe('edit')
  })

  it('changes the owner only for someone who may reassign, and "" means unassigned', () => {
    expect(planTaskEdit(TASK, { ...same, owner: '' }, false)).toEqual({ kind: 'unchanged' })
    expect(planTaskEdit(TASK, { ...same, owner: '' }, true)).toEqual({ kind: 'edit', edit: { id: 't1', ownerId: null }, changed: ['owner'] })
  })

  it('keeps the milestone when the select is left on "keep", and changes it when chosen', () => {
    expect(planTaskEdit(TASK, { ...same, milestone: '' }, true)).toEqual({ kind: 'unchanged' })
    expect(planTaskEdit(TASK, { ...same, milestone: 'MS1-3', priority: 'urgent' }, true)).toEqual({
      kind: 'edit', edit: { id: 't1', priority: 'urgent', milestoneKey: 'MS1-3' }, changed: ['priority', 'milestone'],
    })
  })

  // F6-02: the database refuses a task whose section belongs to another milestone
  // (enforce_task_milestone_consistency), so a milestone-only write of a sectioned task always failed.
  it('takes a sectioned task out of its section when it moves to another milestone, and says so', () => {
    const sectioned = { ...TASK, section_id: 'sec-1' }
    expect(planTaskEdit(sectioned, { ...same, milestone: 'MS1-3' }, true)).toEqual({
      kind: 'edit', edit: { id: 't1', milestoneKey: 'MS1-3', sectionId: null }, changed: ['milestone (left its section)'],
    })
    // Keeping the milestone keeps the section: nothing is sent.
    expect(planTaskEdit(sectioned, same, true)).toEqual({ kind: 'unchanged' })
  })
})

describe('planScheduleEdit', () => {
  it('refuses to remove the deadline of a task created from a proposal', () => {
    const plan = planScheduleEdit({ ...TASK, links_required: true }, '2026-10-01', null)
    expect(plan.kind).toBe('invalid')
    // Moving it is fine.
    expect(planScheduleEdit({ ...TASK, links_required: true }, '2026-10-01', '2026-10-25')).toEqual({
      kind: 'edit', edit: { id: 't1', dueDate: '2026-10-25' }, changed: ['deadline'],
    })
  })

  it('refuses a start after the deadline, and accepts the same day', () => {
    expect(planScheduleEdit(TASK, '2026-10-21', '2026-10-20')).toEqual({ kind: 'invalid', reason: 'The start date must be on or before the deadline.' })
    expect(planScheduleEdit(TASK, '2026-10-20', '2026-10-20').kind).toBe('edit')
  })

  it('moves both dates together (a dragged bar) and nothing else', () => {
    expect(planScheduleEdit(TASK, '2026-10-03', '2026-10-22')).toEqual({
      kind: 'edit', edit: { id: 't1', dueDate: '2026-10-22', startsOn: '2026-10-03' }, changed: ['deadline', 'start date'],
    })
    expect(planScheduleEdit(TASK, TASK.starts_on, TASK.due_date)).toEqual({ kind: 'unchanged' })
  })
})

describe('blocker reasons', () => {
  const BLOCKED = { ...TASK, state: 'blocked' as const, blocked_reason: 'Waiting for the supplier' }
  const blockedSame = { ...same, blockedReason: 'Waiting for the supplier' }

  it('sends a rewritten reason, trimmed', () => {
    expect(planTaskEdit(BLOCKED, { ...blockedSame, blockedReason: '  Supplier shipped ' }, true)).toEqual({
      kind: 'edit', edit: { id: 't1', blockedReason: 'Supplier shipped' }, changed: ['blocker reason'],
    })
  })

  it('refuses to remove the only explanation of a blocked task, and says why', () => {
    const plan = planTaskEdit(BLOCKED, { ...blockedSame, blockedReason: '  ' }, true)
    expect(plan).toMatchObject({ kind: 'invalid' })
    expect((plan as { reason: string }).reason).toMatch(/must say why/)
  })

  it('allows an empty reason when a prerequisite task explains the block', () => {
    expect(planTaskEdit(BLOCKED, { ...blockedSame, blockedReason: '' }, true, { hasPrerequisites: true })).toEqual({
      kind: 'edit', edit: { id: 't1', blockedReason: null }, changed: ['blocker reason removed'],
    })
  })

  it('refuses a reason over 500 characters before anything is written', () => {
    expect(planTaskEdit(BLOCKED, { ...blockedSame, blockedReason: 'x'.repeat(501) }, true)).toMatchObject({ kind: 'invalid' })
  })

  it('ignores the reason field on a task that is not Blocked', () => {
    expect(planTaskEdit(TASK, { ...same, blockedReason: 'stale text' }, true)).toEqual({ kind: 'unchanged' })
  })

  it('a legacy Blocked task with no reason is unchanged until someone edits something', () => {
    const legacy = { ...TASK, state: 'blocked' as const, blocked_reason: null }
    expect(planTaskEdit(legacy, same, true)).toEqual({ kind: 'unchanged' })
  })
})

describe('required dates', () => {
  it('a task that came from a proposal keeps its deadline even if links_required is not set', () => {
    const plan = planScheduleEdit({ id: 't1', starts_on: null, due_date: '2026-10-20', links_required: false, source_proposal: 'p1' }, null, null)
    expect(plan).toMatchObject({ kind: 'invalid' })
    expect((plan as { reason: string }).reason).toMatch(/must keep a deadline/)
  })

  it('a task that never came from a proposal may have its deadline cleared', () => {
    expect(planScheduleEdit({ id: 't1', starts_on: null, due_date: '2026-10-20', links_required: false, source_proposal: null }, null, null)).toEqual({
      kind: 'edit', edit: { id: 't1', dueDate: null }, changed: ['deadline removed'],
    })
  })

  it('a start after the deadline is refused on the pair that would be written, whichever side moved', () => {
    expect(planScheduleEdit({ id: 't1', starts_on: '2026-10-01', due_date: '2026-10-20', links_required: false }, '2026-10-25', '2026-10-20').kind).toBe('invalid')
    expect(planScheduleEdit({ id: 't1', starts_on: '2026-10-01', due_date: '2026-10-20', links_required: false }, '2026-10-01', '2026-09-30').kind).toBe('invalid')
    expect(planScheduleEdit({ id: 't1', starts_on: '2026-10-01', due_date: '2026-10-20', links_required: false }, '2026-10-20', '2026-10-20').kind).toBe('edit')
  })
})
