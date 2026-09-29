#!/usr/bin/env node
// Local development setup against the local Supabase stack (never a hosted one).
//
//   npm run local:setup   start the local stack if it is not running, apply any
//                         pending migrations (forward only — never a reset), then
//                         set up the Requirements Book (npm run book:sync:local).
//   npm run dev           runs this with --predev first (the `predev` script):
//                         when the dev server will talk to a LOCAL stack, the
//                         stack must be up and migrated, and the Book is synced
//                         (a no-op once done). When it will talk to a hosted
//                         project, nothing here runs.
//
// It never starts or resets anything from the browser, never runs in a
// production build, and passes no credentials to the app: the service-role key
// stays inside scripts/book/sync-local.mjs.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const predev = process.argv.includes('--predev')

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', ...opts })
const supabase = (args, opts) => run('npx', ['--no-install', 'supabase', ...args], opts)
const fail = (message) => {
  console.error(`local setup — ${message}`)
  process.exit(1)
}

function stackRunning() {
  const status = supabase(['status', '-o', 'json'])
  if (status.status !== 0) return false
  try {
    const api = new URL(JSON.parse(status.stdout.slice(status.stdout.indexOf('{'))).API_URL)
    return LOCAL_HOSTS.has(api.hostname)
  } catch {
    return false
  }
}

function pendingMigrations() {
  const list = supabase(['migration', 'list', '--local', '--output-format', 'json'])
  if (list.status !== 0) fail('could not read the local migration history (npx supabase migration list --local).')
  const { migrations } = JSON.parse(list.stdout.slice(list.stdout.indexOf('{')))
  return migrations.filter((m) => m.local && !m.remote).map((m) => m.local)
}

if (predev) {
  // The same variables Vite will use for `npm run dev` (mode development).
  const { loadEnv } = await import('vite')
  const url = loadEnv('development', REPO, 'VITE_').VITE_SUPABASE_URL
  let host = null
  try {
    host = new URL(url).hostname
  } catch {
    host = null
  }
  if (!host || !LOCAL_HOSTS.has(host)) {
    console.log('local setup — the dev server targets a hosted Supabase project; local Book setup does not apply.')
    process.exit(0)
  }
  if (!stackRunning()) fail('the dev server targets the local Supabase stack, but it is not running.\n  Start and prepare it with:  npm run local:setup')
  const pending = pendingMigrations()
  if (pending.length) fail(`${pending.length} local migration(s) are not applied yet (${pending.join(', ')}).\n  Apply them with:  npm run local:setup`)
} else {
  if (!stackRunning()) {
    console.log('local setup — starting the local Supabase stack (npx supabase start)…')
    const start = supabase(['start'], { stdio: 'inherit' })
    if (start.status !== 0) fail('npx supabase start failed. Is Docker running?')
  }
  console.log('local setup — applying pending migrations (npx supabase migration up --local)…')
  const up = supabase(['migration', 'up', '--local'], { stdio: 'inherit' })
  if (up.status !== 0) fail('applying the local migrations failed; nothing further was done.')
}

const sync = run(process.execPath, [path.join(REPO, 'scripts/book/sync-local.mjs')], { stdio: 'inherit' })
if (sync.status === 2) {
  // A described conflict (another source already configured, a different
  // file): reported above, left untouched. The app still runs; the Book shows
  // whatever is configured.
  console.warn('local setup — the Requirements Book was NOT set up (see above). Everything else is ready.')
  process.exit(predev ? 0 : 2)
}
if (sync.status !== 0) process.exit(sync.status ?? 1)
