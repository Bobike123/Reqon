#!/usr/bin/env node
// Creates the two private buckets the LOCAL stack uses as a stand-in for Cloudflare R2
// (docs/ultraplan, requirement ATT-20): `attachments-local` and `backups-local`.
//
//   node scripts/attachments/local-buckets.mjs
//
// They used to be declared in supabase/config.toml. Supabase's GitHub integration reads that file on every
// push to main and tries to create the declared buckets in PRODUCTION, which failed ("Payload too large",
// 100 MiB over the hosted limit) and would have left local-only buckets there. Local setup therefore does it
// itself, through the local Storage API. Local only, by construction: refuses any API URL that is not
// 127.0.0.1 / localhost. Safe to run repeatedly.
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const LOCAL_BUCKETS = ['attachments-local', 'backups-local']
const LIMIT_BYTES = 100 * 1024 * 1024 // the largest attachment (a download-only video, Phase 1)

export async function ensureLocalBuckets(root = new URL('../..', import.meta.url).pathname) {
  const status = Object.fromEntries(
    execSync('npx supabase status -o env', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]
      }),
  )
  const api = new URL(status.API_URL ?? 'http://invalid')
  if (!['127.0.0.1', 'localhost'].includes(api.hostname)) throw new Error('Refusing: the API URL is not the local stack.')
  if (!status.SERVICE_ROLE_KEY) throw new Error('`supabase status` reported no service-role key (is the stack running?).')

  const headers = { apikey: status.SERVICE_ROLE_KEY, authorization: `Bearer ${status.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' }
  for (const name of LOCAL_BUCKETS) {
    const res = await fetch(`${api.origin}/storage/v1/bucket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: name, name, public: false, file_size_limit: LIMIT_BYTES }),
    })
    if (res.ok) {
      console.log(`Created the local bucket ${name}.`)
      continue
    }
    const body = await res.text()
    if (res.status === 409 || /already exists|Duplicate/i.test(body)) continue
    throw new Error(`Could not create the local bucket ${name} (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensureLocalBuckets()
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
