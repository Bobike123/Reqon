import { describe, expect, it } from 'vitest'
import { newRequestId, parseMeasurementInput, validatePlausibility } from './measurementInput.ts'

describe('parseMeasurementInput (numeric)', () => {
  it.each([
    ['612', 612],
    ['0', 0],
    ['-0', -0],
    ['-20.5', -20.5],
    ['+3', 3],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['  91.5  ', 91.5],
    ['1000000', 1_000_000],
  ])('accepts %j as %d — zero and negatives are ordinary values', (text, value) => {
    expect(parseMeasurementInput(text, 'numeric')).toEqual({ ok: true, value })
  })

  it('never turns an empty box into a zero or a clear', () => {
    for (const text of ['', '   ']) {
      const parsed = parseMeasurementInput(text, 'numeric')
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.message).toMatch(/empty box does not clear or zero/)
    }
  })

  it.each(['NaN', 'Infinity', '-Infinity', 'abc', '1,000', '12 mm', '0x10', '1..2', '--1', '1e', 'e5', '1_000'])(
    'refuses %j',
    (text) => {
      expect(parseMeasurementInput(text, 'numeric').ok).toBe(false)
    },
  )

  it('refuses a number so large it overflows to infinity', () => {
    const parsed = parseMeasurementInput('1e999', 'numeric')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toMatch(/too large/)
  })

  it('has no global maximum: large finite values are accepted before any per-specification bound is applied', () => {
    expect(parseMeasurementInput('1e300', 'numeric')).toEqual({ ok: true, value: 1e300 })
  })
})

describe('validatePlausibility', () => {
  it('uses only the specification\'s own optional bounds', () => {
    expect(validatePlausibility(300, null, null, 'kg')).toBeNull()
    expect(validatePlausibility(300, 0, 250, 'kg')).toMatch(/plausible maximum is 250 kg/)
    expect(validatePlausibility(-1, 0, 250, null)).toMatch(/plausible minimum is 0/)
    expect(validatePlausibility(0, 0, 250, 'kg')).toBeNull()
    expect(validatePlausibility(250, 0, 250, 'kg')).toBeNull()
  })
})

describe('parseMeasurementInput (boolean)', () => {
  it('accepts an explicit yes or no', () => {
    expect(parseMeasurementInput('true', 'boolean')).toEqual({ ok: true, value: true })
    expect(parseMeasurementInput('false', 'boolean')).toEqual({ ok: true, value: false })
  })

  it('treats "no" as a real value, and nothing chosen as no value', () => {
    expect(parseMeasurementInput('false', 'boolean').ok).toBe(true)
    expect(parseMeasurementInput('', 'boolean').ok).toBe(false)
  })

  it('refuses a number or free text for a yes/no specification', () => {
    for (const text of ['1', '0', 'yes', 'TRUE', 'maybe']) {
      expect(parseMeasurementInput(text, 'boolean').ok).toBe(false)
    }
  })
})

describe('newRequestId', () => {
  it('is a uuid, and a new one each time (a fresh confirmation is a new measurement)', () => {
    const a = newRequestId()
    const b = newRequestId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })

  it('still makes a valid, distinct v4 uuid where crypto.randomUUID is unavailable (plain-http pages)', () => {
    const original = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      const a = newRequestId()
      const b = newRequestId()
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(a).not.toBe(b)
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
    }
  })
})
