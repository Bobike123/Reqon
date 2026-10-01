import type { PostgrestError } from '@supabase/supabase-js'

// The application's one error contract for a failed read or write, so every
// screen has exactly one shape to handle and nothing ever fails silently.
//
// Lives outside data/ on purpose (Phase 6 §6.4/§6.6): it is constructed FROM
// a Supabase PostgrestError, but nothing that merely wants to check
// `error.permission` or read `error.message` needs to import
// @supabase/supabase-js to do it — only this file does.

// Postgres's own wording when Row Level Security or a GRANT refuses a request.
// Accurate, but meaningless to a club member, so it is replaced — while a
// refusal the database explains itself ("The club must always have a
// president…") is shown exactly as written.
const GENERIC_REFUSAL = /row-level security|permission denied|insufficient[_ ]privilege/i

export class DataError extends Error {
  code: string | null
  details: string | null
  // True when the database refused because of WHO is asking, not because
  // something broke. The UI words these differently, and re-reads the
  // caller's roles in case they changed since the screen loaded.
  permission: boolean
  // True when the write was refused because the row changed after the caller
  // read it (a versioned write matched no row). Nothing was written; the screen
  // has been refreshed and the person can look again and re-apply.
  conflict: boolean

  // `what` names the action so it reads after "You don't have permission to …".
  constructor(what: string, error: PostgrestError | null, options: { permission?: boolean; conflict?: boolean } = {}) {
    const permission =
      options.permission ??
      (error !== null && (error.code === '42501' || GENERIC_REFUSAL.test(error.message)))
    super(permission ? refusalMessage(what, error) : error ? `${what}: ${error.message}` : what)
    this.name = 'DataError'
    this.code = error?.code ?? null
    this.details = error?.details ?? null
    this.permission = permission
    this.conflict = options.conflict ?? false
  }
}

function refusalMessage(what: string, error: PostgrestError | null): string {
  if (error && !GENERIC_REFUSAL.test(error.message)) return error.message
  return `You don't have permission to ${what}. Nothing was changed. Ask the President if you need this.`
}

// A refusal because someone else changed the row first, however deeply wrapped.
export function isConflictError(error: unknown): boolean {
  if (error instanceof DataError) return error.conflict
  if (error instanceof Error && error.cause !== undefined) return isConflictError(error.cause)
  return false
}

// A permission refusal, however deeply it has been wrapped.
export function isPermissionError(error: unknown): boolean {
  if (error instanceof DataError) return error.permission
  if (error instanceof Error && error.cause !== undefined) return isPermissionError(error.cause)
  return false
}
