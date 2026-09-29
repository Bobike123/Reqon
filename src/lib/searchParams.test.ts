import { describe, expect, it } from 'vitest'
import { mergeSearchParams, readSetParam, writeSetParam } from './searchParams.ts'

describe('mergeSearchParams', () => {
  it('changes one key and keeps every other (a filter change keeps ?task=)', () => {
    const next = mergeSearchParams(new URLSearchParams('task=abc&scope=mine'), { dept: 'CHASSIS', scope: null })
    expect(next.toString()).toBe('task=abc&dept=CHASSIS')
  })
  it('treats an empty string like null, and never mutates the input', () => {
    const current = new URLSearchParams('search=B.9&rule=B.9.1.2')
    expect(mergeSearchParams(current, { search: '' }).toString()).toBe('rule=B.9.1.2')
    expect(current.toString()).toBe('search=B.9&rule=B.9.1.2')
  })
})

describe('readSetParam / writeSetParam', () => {
  it('reads a comma list, dropping blanks, duplicates and over-long parts, capped', () => {
    const params = new URLSearchParams(`open=a,,b,a, c ,${'x'.repeat(65)}`)
    expect([...readSetParam(params, 'open')]).toEqual(['a', 'b', 'c'])
    expect([...readSetParam(new URLSearchParams('open=a,b,c'), 'open', 2)]).toEqual(['a', 'b'])
    expect(readSetParam(new URLSearchParams(''), 'open').size).toBe(0)
  })
  it('writes the set back, and removes the key when it is empty', () => {
    expect(writeSetParam(new Set(['a', 'b']))).toBe('a,b')
    expect(writeSetParam(new Set())).toBeNull()
  })
})
