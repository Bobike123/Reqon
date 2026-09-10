import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase.ts'
import { AuthContext, type AuthState, type Member } from './context.ts'

// The roster answer, tagged with the user it belongs to. Tagging means a stale
// answer for the previous user can never be shown for the next one, without
// having to reset state from inside an effect.
type Lookup = {
  userId: string
  member: Member | null
  error: string | null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // `undefined` means "not resolved yet"; `null` means "definitely signed out".
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const queryClient = useQueryClient()

  // 1. Track the session. Supabase restores it from localStorage on load, which
  //    is what makes the session survive a reload.
  useEffect(() => {
    let active = true

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session)
      })
      .catch(() => {
        if (active) setSession(null)
      })

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // Deliberately synchronous: calling back into supabase from inside this
      // callback can deadlock on the auth lock. The member row is fetched by
      // the effect below instead.
      setSession(nextSession)
      if (event === 'SIGNED_OUT') {
        // Drop every cached row so the next person to sign in on this browser
        // cannot see the previous person's data.
        setLookup(null)
        queryClient.clear()
      }
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [queryClient])

  // 2. Once we know who is signed in, ask the database whether they are on the
  //    roster. RLS answers this: a caller with no `members` row reads no rows.
  const userId = session?.user.id
  useEffect(() => {
    if (!userId) return

    let active = true
    supabase
      .from('members')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        // A failed lookup is not proof of anything. Report it rather than
        // silently denying (or, worse, silently allowing).
        setLookup({
          userId,
          member: error ? null : data,
          error: error ? error.message : null,
        })
      })

    return () => {
      active = false
    }
  }, [userId, reloadKey])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error ? error.message : null }
  }, [])

  const signOut = useCallback(async () => {
    try {
      await supabase.auth.signOut()
    } catch {
      // Deliberately swallowed. The server call is best-effort; what matters
      // for safety is the local cleanup below, which always runs. Rethrowing
      // would only produce an unhandled rejection at every call site.
    } finally {
      // Runs even if the network call failed. Sign-out must never leave the
      // previous user's rows on screen just because the server was
      // unreachable, so the local session and cache are dropped either way.
      setSession(null)
      setLookup(null)
      queryClient.clear()
    }
  }, [queryClient])

  const retry = useCallback(() => setReloadKey((n) => n + 1), [])

  const state: AuthState = useMemo(() => {
    if (session === undefined) return { status: 'loading' }
    if (session === null) return { status: 'signedOut' }
    // Only trust a lookup that belongs to the user who is signed in right now.
    if (!lookup || lookup.userId !== session.user.id) return { status: 'loading' }
    if (lookup.error) {
      return { status: 'error', user: session.user, message: lookup.error }
    }
    if (lookup.member === null) return { status: 'notRostered', user: session.user }
    return { status: 'member', user: session.user, member: lookup.member }
  }, [session, lookup])

  const value = useMemo(
    () => ({ ...state, signIn, signOut, retry }),
    [state, signIn, signOut, retry],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
