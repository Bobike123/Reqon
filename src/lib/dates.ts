// How this app writes a date, in one place. Before this, four screens printed
// raw ISO ("Due 2026-09-05") while the ledger printed "5 Sep 2026", so the same
// day looked like two different things depending on where you read it.
//
// `<input type="date">` still wants ISO — use todayIso() for those, never
// formatDay().
//
// Date-only policy (ADR-0007): a deadline column (due_date, starts_on,
// opens_on, due_on) is a calendar date, not an instant, and is formatted with
// formatDay(). A recorded-event column (completed_at, archived_at,
// measured_at, observed_at, the activity `at`) is a timestamptz instant, and
// is formatted with formatInstant()/formatInstantDay(). The two are not
// interchangeable: `date.toISOString().slice(0, 10)` reads a Date's UTC
// calendar day, which is the WRONG day for part of every 24 hours outside
// UTC+0 — an evening in a positive-offset time zone is already "tomorrow" in
// UTC, an early morning in a negative-offset one is still "yesterday". Every
// calendar-day conversion in this app goes through toLocalDateString (or
// todayIso, its "right now" convenience) instead, which reads the browser's
// own local year/month/day.
//
// Bug D1 (Phase 0 audit): formatDay was previously given `measured_at`
// (SpecSheet.tsx), a timestamptz, and silently truncated it to its UTC date —
// the wrong calendar day for roughly half the world at any given moment.
// formatDay is now date-only ONLY: passing it something that carries a time
// component returns '' (treated as unparseable) rather than quietly reading
// the wrong day. Use formatInstantDay() for a timestamp's calendar day.

// A Date, as the LOCAL calendar day it falls on — never through UTC.
export function toLocalDateString(date: Date): string {
  return date.toLocaleDateString('en-CA')
}

// Today in the reader's own time zone, as the YYYY-MM-DD a date input wants.
export function todayIso(): string {
  return toLocalDateString(new Date())
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

// A stored calendar date as a person reads it: "5 Sept 2026". Date-only —
// see the file header. Anything that is not exactly YYYY-MM-DD, including a
// full timestamp, returns '' rather than silently reading the wrong (UTC)
// day; genuinely unparseable input does the same.
export function formatDay(iso: string): string {
  if (!DATE_ONLY.test(iso)) return ''
  const day = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(day.getTime())) return ''
  return day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// A stored instant (timestamptz), converted to the reader's own local time
// zone: "5 Sept 2026, 14:30". Use for completed_at, archived_at, measured_at,
// observed_at and activity's `at` — never for a calendar-date column.
export function formatInstant(iso: string): string {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ''
  return instant.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// The same instant, but only its reader-local calendar day: "5 Sept 2026".
// Unlike formatDay, this is meant for a timestamp — it deliberately reads
// the reader's local day off a real instant instead of truncating UTC text.
export function formatInstantDay(iso: string): string {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ''
  return instant.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
