import { describe, expect, it } from 'vitest'
import { buildRequirementOptions, searchRequirements } from './requirementOptions.ts'

const clauses = [
  { clause_key: 'A.1.1.1', printed_ref: 'A.1.1.1', body: 'The vehicle must fit the envelope.', section: 'A', article: 1, article_title: 'General' },
  { clause_key: 'B.2.1.2#1', printed_ref: 'B.2.1.2', body: 'Fairing width is limited.', section: 'B', article: 2, article_title: 'Bodywork' },
  { clause_key: 'B.2.1.2#2', printed_ref: 'B.2.1.2', body: 'A second rule that prints the same reference.', section: 'B', article: 2, article_title: 'Bodywork' },
]

describe('buildRequirementOptions', () => {
  const options = buildRequirementOptions(clauses)

  it('identifies each option by clause_key, never by the printed reference', () => {
    expect(options.map((o) => o.key)).toEqual(['A.1.1.1', 'B.2.1.2#1', 'B.2.1.2#2'])
  })

  it('leaves a unique reference plain', () => {
    expect(options[0]).toMatchObject({ duplicate: false, label: 'A.1.1.1 — The vehicle must fit the envelope.' })
  })

  it('disambiguates a shared printed reference with where it sits and its key', () => {
    expect(options[1].duplicate).toBe(true)
    expect(options[1].label).toContain('section B article 2 Bodywork; key B.2.1.2#1')
    expect(options[2].label).toContain('key B.2.1.2#2')
    expect(new Set(options.map((o) => o.label)).size).toBe(3)
  })

  it('truncates a long rule', () => {
    const [long] = buildRequirementOptions([{ ...clauses[0], body: 'x'.repeat(200) }])
    expect(long.summary.endsWith('…')).toBe(true)
  })
})

describe('searchRequirements', () => {
  const options = buildRequirementOptions(clauses)
  it('returns everything for an empty search, capped', () => {
    expect(searchRequirements(options, '')).toHaveLength(3)
    expect(searchRequirements(options, '', 2)).toHaveLength(2)
  })
  it('matches every typed word against reference, key, wording or article title', () => {
    expect(searchRequirements(options, 'fairing').map((o) => o.key)).toEqual(['B.2.1.2#1'])
    expect(searchRequirements(options, 'b.2.1.2 bodywork').map((o) => o.key)).toEqual(['B.2.1.2#1', 'B.2.1.2#2'])
    expect(searchRequirements(options, 'b.2.1.2#2').map((o) => o.key)).toEqual(['B.2.1.2#2'])
    expect(searchRequirements(options, 'nothing like this')).toEqual([])
  })
})
