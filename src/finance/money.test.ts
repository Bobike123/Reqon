import { describe, expect, it } from 'vitest'
import { centsToInput, formatEuros, parseEuros } from './money.ts'

describe('reading an amount someone typed', () => {
  it.each([
    ['45', 4500],
    ['45.5', 4550],
    ['45,50', 4550],
    ['€ 1234.50', 123450],
    [' 0.01 ', 1],
  ])('%s → %i cents', (text, cents) => {
    expect(parseEuros(text)).toBe(cents)
  })

  it.each(['', '0', '0.00', '-5', 'abc', '1,234.50', '12.345', '1.2.3', '99999999999999999999'])(
    'refuses %j rather than guess',
    (text) => {
      expect(parseEuros(text)).toBeNull()
    },
  )
})

describe('showing money', () => {
  it('formats euros with two decimals', () => {
    expect(formatEuros(4550)).toBe('€45.50')
    expect(formatEuros(123456789)).toBe('€1,234,567.89')
  })

  it('round-trips through the edit field', () => {
    expect(parseEuros(centsToInput(4550))).toBe(4550)
  })
})
