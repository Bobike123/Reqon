// Turning what a person typed into a value the save command can accept.
//
// This is INPUT hygiene, not the regulatory calculation: whether a number
// passes a limit, meets a goal or is plausible for a given specification is
// decided in SQL (spec_verdicts, record_spec_measurement), never here. The
// questions answered here are "is this a number at all", "did they actually
// enter something", and "is it inside this row's declared plausibility
// bounds". The database repeats the plausibility check authoritatively.

export type MeasureKind = 'numeric' | 'boolean'

export type ParsedInput =
  | { ok: true; value: number | boolean }
  | { ok: false; message: string }

// Plain decimal, optional sign, optional exponent. Rejects '', 'NaN',
// 'Infinity', hex ('0x10'), thousands separators and stray text — everything
// Number() would quietly accept or turn into NaN.
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

export function parseMeasurementInput(text: string, kind: MeasureKind): ParsedInput {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, message: 'Enter a value to record. An empty box does not clear or zero a measurement.' }

  if (kind === 'boolean') {
    if (trimmed === 'true') return { ok: true, value: true }
    if (trimmed === 'false') return { ok: true, value: false }
    return { ok: false, message: 'Choose yes or no.' }
  }

  if (!DECIMAL.test(trimmed)) return { ok: false, message: 'Enter a number, for example 612 or -20.5.' }
  const value = Number(trimmed)
  // '1e999' matches the pattern but overflows to Infinity.
  if (!Number.isFinite(value)) return { ok: false, message: 'That number is too large.' }
  return { ok: true, value }
}

export function validatePlausibility(
  value: number,
  minimum: number | null,
  maximum: number | null,
  unit: string | null,
): string | null {
  const suffix = unit ? ` ${unit}` : ''
  if (minimum !== null && value < minimum) {
    return `Enter at least ${minimum}${suffix}; this specification's plausible minimum is ${minimum}${suffix}.`
  }
  if (maximum !== null && value > maximum) {
    return `Enter at most ${maximum}${suffix}; this specification's plausible maximum is ${maximum}${suffix}.`
  }
  return null
}

// A fresh retry identity for one confirmed save. Reused if the same save is
// retried after an error; a new confirmation gets a new one, so a genuine
// repeat measurement of the same value is recorded as new history.
export function newRequestId(): string {
  // randomUUID exists only in secure contexts (https, localhost); a page opened
  // over plain http on a LAN address has getRandomValues but not randomUUID.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
