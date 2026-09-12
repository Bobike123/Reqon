// How this app writes a date, in one place. Before this, four screens printed
// raw ISO ("Due 2026-09-05") while the ledger printed "5 Sep 2026", so the same
// day looked like two different things depending on where you read it.
//
// `<input type="date">` still wants ISO — use todayIso() for those, never
// formatDay().

// Today in the reader's own time zone, as the YYYY-MM-DD a date input wants.
export function todayIso(): string {
  return new Date().toLocaleDateString('en-CA')
}

// A stored date as a person reads it: "5 Sept 2026".
//
// Accepts a date (2026-09-05) or a full timestamp (2026-09-05T10:00:00Z) —
// several columns are timestamps, and every caller having to remember
// .slice(0, 10) is how "Invalid Date" ends up rendered on a screen. Anything
// genuinely unparseable returns '' rather than putting garbage in the page.
export function formatDay(iso: string): string {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(day.getTime())) return ''
  return day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
