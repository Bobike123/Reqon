import { describe, expect, it } from 'vitest'
import { criticalityInfo, obligationInfo, PARKED_INFO } from './labels.ts'

describe('label explanations', () => {
  it('explains NC RISK and PENALTY as consequences', () => {
    expect(criticalityInfo('blocking')).toMatchObject({ label: 'NC RISK' })
    expect(criticalityInfo('blocking')?.summary).toMatch(/NC/)
    expect(criticalityInfo('penalty')).toMatchObject({ label: 'PENALTY' })
    expect(criticalityInfo('penalty')?.summary).toMatch(/MP, SP or NP/)
  })

  it('gives ordinary criticalities no badge', () => {
    for (const value of ['required', 'recommended', 'info', '']) expect(criticalityInfo(value)).toBeNull()
  })

  it('has its own sentence for every obligation kind the regulations use', () => {
    const kinds = ['admin', 'constraint', 'deliverable', 'info', 'process', 'prohibition', 'requirement', 'sporting', 'verification']
    const sentences = new Set<string>()
    for (const kind of kinds) {
      const info = obligationInfo(kind)
      expect(info.label).toBe(kind.toUpperCase())
      expect(info.summary).not.toMatch(/regulations use this word/)
      sentences.add(info.summary)
    }
    expect(sentences.size).toBe(kinds.length)
  })

  it('still explains a kind it has never seen, without inventing a meaning', () => {
    const info = obligationInfo('newkind')
    expect(info.label).toBe('NEWKIND')
    expect(info.summary).toMatch(/newkind/)
  })

  it('separates SPORTING (what kind of rule) from PENALTY (what breaking it costs)', () => {
    expect(obligationInfo('sporting').summary).not.toMatch(/penalty/i)
    expect(criticalityInfo('penalty')?.summary).not.toMatch(/sporting/i)
  })

  it('says PARKED is competition scope and not archival', () => {
    expect(PARKED_INFO.label).toBe('PARKED')
    expect(PARKED_INFO.summary).toMatch(/Final Event/)
    expect(PARKED_INFO.summary).toMatch(/not the same as a department being archived/)
  })
})
