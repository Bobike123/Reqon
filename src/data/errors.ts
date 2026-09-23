import type { PostgrestError } from '@supabase/supabase-js'
import { DataError } from '../core/errors.ts'

// The application error CONTRACT (DataError, isPermissionError) lives in
// core/errors.ts — a neutral location any feature UI can depend on without
// pulling in Supabase types (Phase 6 §6.4/§6.6). This file keeps only the
// data-infrastructure that actually talks to Supabase's PostgrestError/Result
// shape: unwrapping a response, and paging through one.

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

// `page()` must be called with a query already ordered deterministically, and
// that order must end in a column unique across the whole result set (a
// primary key, or a key unique within whatever this call already filtered
// by). Without that, OFFSET pagination has no stable window to page through:
// Postgres owes nothing about row order across two separate requests unless
// ORDER BY says so, and even with one, a row inserted earlier in that order
// than the current offset shifts every later row down a place — so the row
// that was last on one page can legitimately reappear first on the next.
// `getKey` extracts that same unique column from each row so a reappearance
// like that is dropped instead of returned twice.
export async function fetchAllRows<T>(
  what: string,
  getKey: (row: T) => string | number,
  page: (from: number, to: number) => PromiseLike<Result<T[]>>,
): Promise<T[]> {
  const rows: T[] = []
  const seen = new Set<string | number>()
  // Tracked separately from rows.length: a dropped duplicate must not shrink
  // the offset the NEXT request asks for, or the same page would be re-fetched
  // forever instead of advancing.
  let offset = 0

  for (let request = 0; request < MAX_REQUESTS; request += 1) {
    const batch = unwrap(what, await page(offset, offset + REQUEST_SIZE - 1))
    offset += batch.length
    for (const row of batch) {
      const key = getKey(row)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
    // Only an EMPTY page means the server had nothing more to give. A short
    // page (fewer rows than REQUEST_SIZE, but more than zero) is NOT the same
    // thing: the server's own row cap (`max_rows` in supabase/config.toml) can
    // be lower than REQUEST_SIZE, in which case every page looks "short" while
    // rows remain. Advancing by the batch length actually received (not by
    // REQUEST_SIZE) keeps the offset correct either way; this is what keeps
    // the loop running until that is actually true, at the cost of one
    // trailing empty request in the ordinary case.
    if (batch.length === 0) return rows
  }

  throw new DataError(
    `${what}: still more rows after ${MAX_REQUESTS} requests — refusing to loop forever`,
    null,
  )
}
