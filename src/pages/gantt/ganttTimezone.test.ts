import { afterEach, describe, expect, it, vi } from 'vitest'
import { planScheduleEdit } from '../board/taskEditPlan.ts'
import { placeDay, shiftDay } from './ganttModel.ts'
import { toLocalDateString } from '../../lib/dates.ts'

// A deadline is a calendar date, not an instant: dragging or typing one must
// give the same YYYY-MM-DD wherever the reader is, including across the
// clock changes at each end of the year and at the edge of the reader's day.

afterEach(() => {
  vi.unstubAllEnvs()
})

const ZONES = ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/Copenhagen', 'America/Sao_Paulo', 'Australia/Lord_Howe']

describe.each(ZONES)('calendar-day arithmetic in %s', (zone) => {
  it('moves a date by whole days without slipping across a month, year or clock change', () => {
    vi.stubEnv('TZ', zone)
    expect(shiftDay('2026-03-28', 1)).toBe('2026-03-29') // European spring-forward eve
    expect(shiftDay('2026-03-28', 2)).toBe('2026-03-30')
    expect(shiftDay('2026-10-24', 2)).toBe('2026-10-26') // European fall-back
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29') // leap day
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('a dragged period keeps its length and order: both dates move by the same number of days', () => {
    vi.stubEnv('TZ', zone)
    const start = '2026-10-24'
    const due = '2026-10-27'
    const moved = { start: shiftDay(start, 3), due: shiftDay(due, 3) }
    expect(moved).toEqual({ start: '2026-10-27', due: '2026-10-30' })
    const plan = planScheduleEdit({ id: 't', starts_on: start, due_date: due, links_required: true }, moved.start, moved.due)
    expect(plan).toEqual({ kind: 'edit', edit: { id: 't', startsOn: '2026-10-27', dueDate: '2026-10-30' }, changed: ['deadline', 'start date'] })
  })

  it('places the same day at the same spot on the timeline', () => {
    vi.stubEnv('TZ', zone)
    expect(placeDay('2026-11-15', { from: '2026-11-01', to: '2026-11-30' })).toBeCloseTo((14 / 30) * 100, 5)
  })
})

describe('the reader\'s day at the edge of midnight', () => {
  it('a deadline set "today" in a far-east zone is the local day, not the UTC day', () => {
    vi.stubEnv('TZ', 'Pacific/Kiritimati') // UTC+14
    const now = new Date('2026-09-09T12:00:00Z') // 02:00 on the 10th locally
    const today = toLocalDateString(now)
    expect(today).toBe('2026-09-10')
    expect(planScheduleEdit({ id: 't', starts_on: null, due_date: null, links_required: false }, null, today)).toEqual({
      kind: 'edit', edit: { id: 't', dueDate: '2026-09-10' }, changed: ['deadline'],
    })
  })

  it('a deadline set "today" in a far-west zone is the local day, not the UTC day', () => {
    vi.stubEnv('TZ', 'Pacific/Pago_Pago') // UTC-11
    const now = new Date('2026-09-10T05:00:00Z') // 18:00 on the 9th locally
    expect(toLocalDateString(now)).toBe('2026-09-09')
  })

  it('a start on the deadline day is allowed; a start after it is refused, whichever zone', () => {
    expect(planScheduleEdit({ id: 't', starts_on: null, due_date: '2026-10-20', links_required: false }, '2026-10-20', '2026-10-20').kind).toBe('edit')
    expect(planScheduleEdit({ id: 't', starts_on: null, due_date: '2026-10-20', links_required: false }, '2026-10-21', '2026-10-20').kind).toBe('invalid')
  })
})
