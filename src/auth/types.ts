// The application's own shape for "who is signed in" (Phase 6 §6.6) — never
// Supabase's own `User`/`Session`. Everything this app actually reads off a
// session is an id and (for the change-password form) an email; nothing
// downstream of AuthProvider needs to know supabase-js's User type exists.
export type AuthenticatedUser = {
  id: string
  email: string | null
}
