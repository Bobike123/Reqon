import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types.ts'

// The only Supabase client in the app. Import this everywhere; never call
// createClient again, or you get two auth sessions fighting over one browser.
//
// Both values are safe to ship to the browser: the anon key only ever gets the
// access that Row Level Security allows. The service_role key bypasses RLS and
// must never appear in this repository.
//
// Security note for whoever maintains this: signing in does NOT by itself grant
// access to anything. Every table is protected by RLS policies that require a
// matching row in `members` (see is_member() in schema.sql). The React code
// below only *reflects* that decision; it does not make it.

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase configuration. Copy .env.example to .env.local and fill in ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from the Supabase dashboard ' +
      '(Project Settings -> API), then restart `npm run dev`.',
  )
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    // Keep the session in localStorage and refresh it in the background, so a
    // reload does not sign the user out. These are the supabase-js defaults;
    // they are spelled out because Phase 2 depends on them.
    persistSession: true,
    autoRefreshToken: true,
    // Off on purpose. This would read an access token out of the page URL,
    // which only makes sense for magic links, OAuth or password-reset links —
    // none of which this app uses. Leaving it on lets a crafted link plant a
    // session in someone's browser. Turn it back on the same day you add one
    // of those flows, not before.
    detectSessionInUrl: false,
  },
})
