import { describe, expect, it } from 'vitest'
import { DEFAULT_JOB_TITLE, jobTitleOptions, splitRoster, type RosterMember } from './rosterModel.ts'

function member(over: Partial<RosterMember>): RosterMember {
  return { id: 'x', full_name: 'Someone', role: 'Member', status: 'active', ...over }
}

describe('jobTitleOptions', () => {
  it('offers the titles the club already uses, alphabetically', () => {
    expect(
      jobTitleOptions([
        member({ id: 'a', role: 'Chassis' }),
        member({ id: 'b', role: 'Aerodynamics' }),
      ]),
    ).toEqual(['Aerodynamics', 'Chassis', 'Member'])
  })

  it('always offers the schema default, even on an empty roster', () => {
    expect(jobTitleOptions([])).toEqual([DEFAULT_JOB_TITLE])
  })

  it('treats one title spelled two ways as one, keeping the first spelling', () => {
    expect(
      jobTitleOptions([
        member({ id: 'a', role: 'Chassis' }),
        member({ id: 'b', role: 'chassis' }),
        member({ id: 'c', role: '  Chassis  ' }),
      ]),
    ).toEqual(['Chassis', 'Member'])
  })

  it('keeps a title nobody else holds, so an edit can show its own value', () => {
    expect(jobTitleOptions([member({ role: 'Chassis' })], 'Team Principal')).toEqual([
      'Chassis',
      'Member',
      'Team Principal',
    ])
  })

  it('ignores blanks rather than offering an empty choice', () => {
    expect(jobTitleOptions([member({ role: '' }), member({ id: 'b', role: '   ' })], null, '')).toEqual([
      DEFAULT_JOB_TITLE,
    ])
  })
})

describe('splitRoster', () => {
  it('puts current members before retired ones, keeping name order', () => {
    const roster = [
      member({ id: 'a', full_name: 'Ada' }),
      member({ id: 'b', full_name: 'Bo', status: 'alumni' }),
      member({ id: 'c', full_name: 'Cy' }),
    ]
    const { active, alumni } = splitRoster(roster)
    expect(active.map((m) => m.full_name)).toEqual(['Ada', 'Cy'])
    expect(alumni.map((m) => m.full_name)).toEqual(['Bo'])
  })
})
