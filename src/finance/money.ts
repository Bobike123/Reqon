// Money is whole cents (bigint in Postgres), so nothing is lost to floating
// point. Euros throughout: MotoStudent's economical plan must be in € (F.7.1.7).

// Mirrors the database check on finance_entries.amount_cents.
const MAX_CENTS = 100_000_000_000

const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })

export function formatEuros(cents: number): string {
  return euros.format(cents / 100)
}

// "45", "45.5", "45,50", "€ 1234.50" → cents. Anything else → null.
// One decimal separator (either kind), at most two decimals, and no thousands
// separators — "1.234" could be a thousand or a euro twenty-three.
export function parseEuros(input: string): number | null {
  const text = input.replace(/[\s€]/g, '')
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(text)
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CENTS ? cents : null
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2)
}

// Today in the reader's own time zone, as the YYYY-MM-DD a date input wants.
export function todayIso(): string {
  return new Date().toLocaleDateString('en-CA')
}

export function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
