// create-member — add a new person to the club: their login AND their roster
// row, in one step, from Settings -> Roster.
//
// Why this is an Edge Function and not browser code: creating a Supabase Auth
// user needs the service-role key, which bypasses Row Level Security. Here it
// stays on the server (Supabase injects SUPABASE_SERVICE_ROLE_KEY into the
// function's environment) and is used for exactly ONE call — auth.admin
// .createUser — plus deleting that same user again if the roster step fails.
//
// Everything else runs AS THE CALLER, with their own access token, so the
// database decides (migration 20260131000000_member_onboarding.sql):
//   1. can_add_members()     must answer true for the caller — an active
//                            President, Vice President or Developer;
//   2. the roster INSERT     goes through RLS (admin_roster_insert), which
//                            asks can_add_members() again.
// A new person never gets a privileged role here; that stays with
// apply_role_plan() / can_grant_role() in the role dialog.
//
// Request:  POST { email, password, fullName, jobTitle? }
// Response: 200 { id } | 4xx/5xx { error }
// Passwords are never logged or echoed back.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const corsHeaders = {
  // A bearer token, not a cookie, carries the caller's identity, so a wildcard
  // origin cannot be used to act as someone else.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Same limits the SQL script (supabase/scripts/new_member.sql) uses, plus
// upper bounds so nothing unbounded reaches Auth or the roster.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8
const MAX_PASSWORD = 72 // bcrypt ignores everything after 72 bytes
const MAX_NAME = 120
const MAX_TITLE = 80

type Input = { email: string; password: string; fullName: string; jobTitle: string }

function parse(raw: unknown): Input | string {
  if (typeof raw !== 'object' || raw === null) return 'Send a JSON body.'
  const body = raw as Record<string, unknown>
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : ''
  const jobTitle = typeof body.jobTitle === 'string' && body.jobTitle.trim() ? body.jobTitle.trim() : 'Member'

  if (!EMAIL.test(email) || email.length > 254) return 'Give a real email address.'
  if (password.length < MIN_PASSWORD) return `The password must be at least ${MIN_PASSWORD} characters.`
  if (new TextEncoder().encode(password).length > MAX_PASSWORD) {
    return `The password must be at most ${MAX_PASSWORD} characters.`
  }
  if (!fullName) return 'Give the person a full name — it is what every screen shows.'
  if (fullName.length > MAX_NAME) return `The full name must be at most ${MAX_NAME} characters.`
  if (jobTitle.length > MAX_TITLE) return `The job title must be at most ${MAX_TITLE} characters.`
  return { email, password, fullName, jobTitle }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return reply(500, { error: 'The function is not configured.' })

  const authorization = req.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return reply(401, { error: 'Sign in first.' })

  // The caller's own client: every database call below is judged by RLS as them.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Validates the token with the Auth server — not just its signature — so a
  // signed-out or deleted user is refused here.
  const { data: who, error: whoError } = await asCaller.auth.getUser(authorization.slice('Bearer '.length))
  if (whoError || !who.user) return reply(401, { error: 'Your session has expired. Sign in again.' })

  const { data: allowed, error: allowedError } = await asCaller.rpc('can_add_members')
  if (allowedError) return reply(500, { error: 'Could not check your permission. Nothing was changed.' })
  if (allowed !== true) {
    return reply(403, {
      error: 'Only an active President, Vice President or Developer may add people to the roster. Nothing was changed.',
    })
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return reply(400, { error: 'Send a JSON body.' })
  }
  const input = parse(raw)
  if (typeof input === 'string') return reply(400, { error: input })

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // email_confirm: they can sign in straight away with the password they are
  // given, and change it in Settings -> Your account.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  })
  if (createError || !created.user) {
    // weak_password is also a 422, so it is checked before the email_exists
    // fallback on status, which would otherwise call it "already exists".
    if (createError?.code === 'weak_password') {
      return reply(400, { error: 'That password is too weak. Choose a longer one.' })
    }
    if (createError?.code === 'email_exists' || (!createError?.code && createError?.status === 422)) {
      return reply(409, {
        error: `A login already exists for ${input.email}. If they are not on the roster yet, link it by UUID instead.`,
      })
    }
    console.error('create-member: createUser failed', createError?.code ?? createError?.status)
    return reply(500, { error: 'Could not create the login. Nothing was changed.' })
  }

  const newId = created.user.id
  const { error: rosterError } = await asCaller
    .from('members')
    .insert({ id: newId, full_name: input.fullName, role: input.jobTitle })

  if (rosterError) {
    // Undo the login so no account without a roster row is left behind.
    const { error: undoError } = await admin.auth.admin.deleteUser(newId)
    console.error('create-member: roster insert failed', rosterError.code, undoError ? 'and undo failed' : 'login removed')
    if (undoError) {
      return reply(500, {
        error: `The login for ${input.email} was created but could not be added to the roster, and removing it failed. Delete it in the Supabase dashboard (Authentication -> Users) before trying again.`,
      })
    }
    const refused = rosterError.code === '42501' || /row-level security/i.test(rosterError.message)
    return reply(refused ? 403 : 500, {
      error: refused
        ? 'Only an active President, Vice President or Developer may add people to the roster. Nothing was changed.'
        : 'Could not add them to the roster. Nothing was changed.',
    })
  }

  // Audit line in the function logs: who added whom. No email, no password.
  console.log('create-member: added', newId, 'by', who.user.id)
  return reply(200, { id: newId })
})
