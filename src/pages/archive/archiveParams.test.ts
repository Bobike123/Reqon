import { describe, expect, it } from 'vitest'
import { archiveParamsToSearch, hasActiveFilters, pageCount, parseArchiveParams, toProposalQuery, toTaskQuery } from './archiveParams.ts'

const parse = (qs: string) => parseArchiveParams(new URLSearchParams(qs))

describe('parseArchiveParams', () => {
  it('defaults to the first page of archived tasks with no filters', () => {
    const { value, notice } = parse('')
    expect(value).toEqual({ tab: 'tasks', department: '', owner: '', state: '', search: '', id: '', page: 0 })
    expect(notice).toBeNull()
    expect(hasActiveFilters(value)).toBe(false)
  })

  it('reads every filter and converts the 1-based page', () => {
    const { value } = parse('tab=proposals&dept=AERO&owner=m1&state=rejected&q=wing&page=3&id=abc')
    expect(value).toEqual({ tab: 'proposals', department: 'AERO', owner: 'm1', state: 'rejected', search: 'wing', id: 'abc', page: 2 })
    expect(hasActiveFilters(value)).toBe(true)
  })

  it('does not trust an unknown tab, status or page: it falls back and says so', () => {
    expect(parse('tab=secrets').value.tab).toBe('tasks')
    expect(parse('tab=secrets').notice).toMatch(/not part of the Archive/)
    expect(parse('state=urgent').value.state).toBe('')
    expect(parse('state=urgent').notice).toMatch(/not a status/)
    expect(parse('page=-4').value.page).toBe(0)
    expect(parse('page=abc').notice).toMatch(/page number/)
  })

  it('takes task states on the tasks tab and outcomes on the proposals tab', () => {
    expect(parse('state=done').value.state).toBe('done')
    expect(parse('tab=proposals&state=done').value.state).toBe('')
    expect(parse('tab=proposals&state=approved').value.state).toBe('approved')
  })
})

describe('archiveParamsToSearch', () => {
  it('writes only non-default values and round-trips', () => {
    expect(archiveParamsToSearch(parse('').value).toString()).toBe('')
    const original = 'tab=proposals&dept=AERO&state=approved&q=wing&page=2'
    expect(archiveParamsToSearch(parse(original).value).toString()).toBe(new URLSearchParams(original).toString())
  })
})

describe('queries', () => {
  it('maps to the task and proposal queries', () => {
    const v = parse('dept=AERO&owner=m1&state=done&q=x&page=2').value
    expect(toTaskQuery(v)).toEqual({ department: 'AERO', owner: 'm1', state: 'done', search: 'x', id: '', page: 1 })
    expect(toProposalQuery(parse('tab=proposals&state=rejected').value).status).toBe('rejected')
    expect(toProposalQuery(parse('tab=proposals').value).status).toBe('')
  })
  it('counts pages, never below one', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(25)).toBe(1)
    expect(pageCount(26)).toBe(2)
  })
})
