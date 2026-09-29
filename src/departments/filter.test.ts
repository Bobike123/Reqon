import { describe, expect, it } from 'vitest'
import { ALL_DEPARTMENTS, departmentChoices, resolveDepartmentParam } from './filter.ts'

const departments = [
  { key: 'AERO', name: 'Aerodynamics', archived_at: null },
  { key: 'BODY', name: 'Bodywork', archived_at: null },
  { key: 'OLD', name: 'Retired dept', archived_at: '2026-01-01' },
]

describe('departmentChoices', () => {
  it('lists active departments only by default', () => {
    expect(departmentChoices(departments).map((d) => d.key)).toEqual(['AERO', 'BODY'])
  })
  it('adds a named archived department, marked as archived', () => {
    const choices = departmentChoices(departments, new Set(['OLD']))
    expect(choices.map((d) => d.label)).toEqual(['Aerodynamics', 'Bodywork', 'Retired dept (archived)'])
  })
})

describe('resolveDepartmentParam', () => {
  it('reads nothing, "all" and an empty value as all departments, quietly', () => {
    for (const value of [null, '', ALL_DEPARTMENTS]) expect(resolveDepartmentParam(value, departments)).toEqual({ department: ALL_DEPARTMENTS, notice: null })
  })
  it('keeps a known department, active or archived', () => {
    expect(resolveDepartmentParam('AERO', departments)).toEqual({ department: 'AERO', notice: null })
    expect(resolveDepartmentParam('OLD', departments)).toEqual({ department: 'OLD', notice: null })
  })
  it('falls back to all departments WITH a notice for an unknown or deleted one', () => {
    const result = resolveDepartmentParam('GONE', departments)
    expect(result.department).toBe(ALL_DEPARTMENTS)
    expect(result.notice).toContain('“GONE”')
  })
})
