import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDay, toLocalDateString, todayIso } from './dates.ts'

// TZ is read live by V8/ICU on every Date/Intl call in this runtime, so each
// test can pin a specific reader's time zone without any system-level
// configuration — this is what makes "before/after local midnight", "UTC
// offset boundaries" and "a daylight-saving transition" reproducible at all,
// rather than depending on whatever zone happens to run the suite.
function withTZ(tz: string, run: () => void) {
  vi.stubEnv('TZ', tz)
  run()
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('toLocalDateString', () => {
  it('reads the local calendar day at a positive UTC offset, past local midnight', () => {
    withTZ('Pacific/Kiritimati', () => {
      // UTC+14: 2026-09-09T12:00:00Z is already 2026-09-10 02:00 local.
      expect(toLocalDateString(new Date('2026-09-09T12:00:00Z'))).toBe('2026-09-10')
    })
  })

  it('reads the local calendar day at a negative UTC offset, before local midnight', () => {
    withTZ('Etc/GMT+12', () => {
      // UTC-12: 2026-09-09T05:00:00Z is still 2026-09-08 17:00 local.
      expect(toLocalDateString(new Date('2026-09-09T05:00:00Z'))).toBe('2026-09-08')
    })
  })

  it('agrees with the UTC calendar day when the reader is in UTC', () => {
    withTZ('UTC', () => {
      expect(toLocalDateString(new Date('2026-09-09T00:00:01Z'))).toBe('2026-09-09')
      expect(toLocalDateString(new Date('2026-09-09T23:59:59Z'))).toBe('2026-09-09')
    })
  })

  it('lands on different calendar days either side of local midnight', () => {
    withTZ('Europe/Copenhagen', () => {
      // Local midnight (2026-09-10T00:00 CEST, UTC+2) is 2026-09-09T22:00:00Z.
      expect(toLocalDateString(new Date('2026-09-09T21:59:59Z'))).toBe('2026-09-09') // just before
      expect(toLocalDateString(new Date('2026-09-09T22:00:01Z'))).toBe('2026-09-10') // just after
    })
  })

  it('stays correct across a daylight-saving transition', () => {
    withTZ('Europe/Copenhagen', () => {
      // Clocks go back from CEST (UTC+2) to CET (UTC+1) at 2026-10-25 03:00
      // CEST. The calendar day itself is unaffected by the clock change.
      expect(toLocalDateString(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25') // 02:30 CEST
      expect(toLocalDateString(new Date('2026-10-25T23:30:00Z'))).toBe('2026-10-26') // 00:30 CET, next day
    })
  })

  it('is the fix for the UTC-slicing bug: toISOString().slice(0, 10) gets this wrong', () => {
    withTZ('Pacific/Kiritimati', () => {
      const instant = new Date('2026-09-09T12:00:00Z')
      // The exact pattern Phase 5 replaces: reading a Date's UTC calendar day
      // instead of the reader's own local one.
      expect(instant.toISOString().slice(0, 10)).toBe('2026-09-09') // the wrong local day
      expect(toLocalDateString(instant)).toBe('2026-09-10') // the correct one
    })
  })
})

describe('todayIso', () => {
  it('is toLocalDateString(new Date()) — one implementation, not two', () => {
    expect(todayIso()).toBe(toLocalDateString(new Date()))
  })
})

describe('formatDay', () => {
  it('reads a date-only string as local midnight, not UTC midnight', () => {
    // Guards the OTHER half of this file: formatDay parses without a "Z"
    // suffix on purpose (`${iso}T00:00:00`, no Z) so a plain YYYY-MM-DD never
    // shifts a day backwards for a reader west of UTC.
    withTZ('Etc/GMT+12', () => {
      expect(formatDay('2026-09-09')).toBe('9 Sept 2026')
    })
  })

  it('returns empty rather than "Invalid Date" for unparseable input', () => {
    expect(formatDay('not-a-date')).toBe('')
  })
})
