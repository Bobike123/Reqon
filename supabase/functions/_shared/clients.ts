// Deno-only helpers for the attachment Edge Functions: the caller's own Supabase client (every
// call judged by RLS as them, after the token was checked with the Auth server) and the
// service client (used only for confirm_attachment, reading a pending row, and the purge job).

import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.117.2'
import { reply, storageConfig, type StorageConfig } from './attachments.ts'
import { backupStorageConfig, type BackupStorage } from './backups.ts'

const noSession = { persistSession: false, autoRefreshToken: false }

export function bucket(): StorageConfig | Response {
  const cfg = storageConfig((name) => Deno.env.get(name))
  return cfg ?? reply(500, { error: 'File storage is not configured.' })
}

export function backupBucket(): BackupStorage | Response {
  const cfg = backupStorageConfig((name) => Deno.env.get(name))
  return cfg ?? reply(500, { error: 'Backup storage is not configured.' })
}

export async function caller(req: Request): Promise<{ client: SupabaseClient; user: User } | Response> {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anonKey) return reply(500, { error: 'The function is not configured.' })
  const authorization = req.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return reply(401, { error: 'Sign in first.' })
  const client = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: noSession })
  // Validates the token with the Auth server — not just its signature — so a signed-out or
  // deleted user is refused here.
  const { data, error } = await client.auth.getUser(authorization.slice('Bearer '.length))
  if (error || !data.user) return reply(401, { error: 'Your session has expired. Sign in again.' })
  return { client, user: data.user }
}

export function service(): SupabaseClient | Response {
  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) return reply(500, { error: 'The function is not configured.' })
  return createClient(url, serviceKey, { auth: noSession })
}

export async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}
