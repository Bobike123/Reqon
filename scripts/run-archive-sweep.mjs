#!/usr/bin/env node

// Trusted-server fallback when the target database cannot run pg_cron.
// This is deliberately not imported by the browser application. A server
// scheduler supplies the service credential and invokes this process every
// five minutes; the RPC accepts no client clock or actor.
const baseUrl = process.env.ARCHIVE_SCHEDULER_SUPABASE_URL?.replace(/\/$/, '')
const serviceKey = process.env.ARCHIVE_SCHEDULER_SERVICE_ROLE_KEY

if (!baseUrl || !serviceKey) {
  throw new Error(
    'Set ARCHIVE_SCHEDULER_SUPABASE_URL and ARCHIVE_SCHEDULER_SERVICE_ROLE_KEY in the trusted scheduler environment.',
  )
}

const response = await fetch(`${baseUrl}/rest/v1/rpc/archive_stale_done_tasks`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  },
  body: '{}',
  signal: AbortSignal.timeout(30_000),
})

if (!response.ok) {
  const message = (await response.text()).slice(0, 1_000)
  throw new Error(`Archive sweep failed (${response.status}): ${message}`)
}

const rows = await response.json()
if (!Array.isArray(rows)) throw new Error('Archive sweep returned an unexpected response shape.')
process.stdout.write(`Archive sweep completed; ${rows.length} task(s) archived.\n`)
