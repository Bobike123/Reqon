import type { User } from '@supabase/supabase-js'
import { createContext, useContext } from 'react'
import type { Database } from '../lib/database.types.ts'

export type Member = Database['public']['Tables']['members']['Row']

// Being signed in is not the same as being allowed in. The club roster is the
// `members` table, and the database enforces it: is_member() in schema.sql
// gates every RLS policy. These states mirror what the database will do.
export type AuthState =
  // Still working out who the caller is. Never render protected UI here.
  | { status: 'loading' }
  // No Supabase session at all.
  | { status: 'signedOut' }
  // Signed in, but no matching `members` row — not on the club roster.
  | { status: 'notRostered'; user: User }
  // Signed in and on the roster. `member` is the caller's own row.
  | { status: 'member'; user: User; member: Member }
  // We could not find out. Do NOT fall through to either allow or deny.
  | { status: 'error'; user: User; message: string }

export type AuthContextValue = AuthState & {
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  retry: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used inside <AuthProvider>.')
  }
  return value
}
