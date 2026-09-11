import type { PostgrestError } from '@supabase/supabase-js'

// Postgres's own wording when Row Level Security or a GRANT refuses a request.
// Accurate, but meaningless to a club member, so it is replaced — while a
// refusal the database explains itself ("The club must always have a
// president…") is shown exactly as written.
const GENERIC_REFUSAL = /row-level security|permission denied|insufficient[_ ]privilege/i

// Every failed read or write becomes one of these, so the UI has exactly one
// error shape to handle and nothing ever fails silently.
export class DataError extends Error {
  code: string | null
  details: string | null
  // True when the database refused because of WHO is asking, not because
  // something broke. The UI words these differently, and re-reads the
  // caller's roles in case they changed since the screen loaded.
  permission: boolean

  // `what` names the action so it reads after "You don't have permission to …".
  constructor(what: string, error: PostgrestError | null, options: { permission?: boolean } = {}) {
    const permission =
      options.permission ??
      (error !== null && (error.code === '42501' || GENERIC_REFUSAL.test(error.message)))
    super(permission ? refusalMessage(what, error) : error ? `${what}: ${error.message}` : what)
    this.name = 'DataError'
    this.code = error?.code ?? null
    this.details = error?.details ?? null
    this.permission = permission
  }
}

function refusalMessage(what: string, error: PostgrestError | null): string {
  if (error && !GENERIC_REFUSAL.test(error.message)) return error.message
  return `You don't have permission to ${what}. Nothing was changed. Ask the President if you need this.`
}

// A permission refusal, however deeply it has been wrapped.
export function isPermissionError(error: unknown): boolean {
  if (error instanceof DataError) return error.permission
  if (error instanceof Error && error.cause !== undefined) return isPermissionError(error.cause)
  return false
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
