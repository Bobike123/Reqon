import { describe, expect, it } from 'vitest'
import { planScheduleEdit, planTaskEdit, type TaskFormValues } from './taskEditPlan.ts'

const TASK = {
  id: 't1', title: 'Weld the frame', detail: 'Jig first', starts_on: '2026-10-01', due_date: '2026-10-20',
  priority: 'normal' as const, milestone_key: 'MS1-2', owner_id: 'm1', links_required: false,
}
const same: TaskFormValues = {
  title: TASK.title, detail: TASK.detail, start: TASK.starts_on, due: TASK.due_date, priority: 'normal', milestone: 'MS1-2', owner: 'm1',
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
