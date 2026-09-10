import type { PostgrestError } from '@supabase/supabase-js'

// Every failed read or write becomes one of these, so the UI has exactly one
// error shape to handle and nothing ever fails silently.
export class DataError extends Error {
  code: string | null
  details: string | null

  constructor(what: string, error: PostgrestError | null) {
    super(error ? `${what}: ${error.message}` : what)
    this.name = 'DataError'
    this.code = error?.code ?? null
    this.details = error?.details ?? null
  }
}

type Result<T> = { data: T | null; error: PostgrestError | null }

// Turn a Supabase result into a value or a throw. TanStack Query turns the
// throw into `error` on the hook, which is what makes failures visible.
export function unwrap<T>(what: string, result: Result<T>): T {
  if (result.error) throw new DataError(what, result.error)
  if (result.data === null) throw new DataError(`${what}: no data returned`, null)
  return result.data
}

// Same, but `null` is a legitimate answer (e.g. "no row for this key").
export function unwrapMaybe<T>(what: string, result: Result<T>): T | null {
  if (result.error) throw new DataError(what, result.error)
  return result.data
}

// Supabase caps how many rows one request may return (`max_rows` in
// supabase/config.toml, 1000 by default — and there are 1,146 clauses). Over
// that limit the response is truncated with NO error, so a plain .select()
// would quietly lose 146 regulations. Always page through instead.
const REQUEST_SIZE = 1000
const MAX_REQUESTS = 50

export async function fetchAllRows<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<Result<T[]>>,
): Promise<T[]> {
  const rows: T[] = []

  for (let request = 0; request < MAX_REQUESTS; request += 1) {
    const from = rows.length
    const batch = unwrap(what, await page(from, from + REQUEST_SIZE - 1))
    rows.push(...batch)
    // A short page means the server had nothing more to give. Advancing by the
    // batch length (not by REQUEST_SIZE) keeps this correct even if the server
    // caps pages lower than we asked for.
    if (batch.length === 0 || batch.length < REQUEST_SIZE) return rows
  }

  throw new DataError(
    `${what}: still more rows after ${MAX_REQUESTS} requests — refusing to loop forever`,
    null,
  )
}
