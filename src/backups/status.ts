import { formatBytes } from '../attachments/rules.ts'
import type { BackupRun } from '../data/useBackups.ts'

// How healthy each backup destination looks, from the rows the workflow recorded (Ultraplan Phase 4;
// BAK-08/09). Pure: the panel only displays what this decides. The daily R2 copy is expected every ~24 h
// (stale after 48 h); the GitHub and Drive copies are weekly (stale after 9 days).

export type Destination = 'r2' | 'github' | 'drive'

export const DESTINATIONS: readonly { id: Destination; label: string; staleAfterHours: number; cadence: string }[] = [
  { id: 'r2', label: 'Cloudflare R2 (daily)', staleAfterHours: 48, cadence: 'every day' },
  { id: 'github', label: 'Private GitHub repository (weekly)', staleAfterHours: 9 * 24, cadence: 'every Sunday' },
  { id: 'drive', label: 'Google Drive (weekly)', staleAfterHours: 9 * 24, cadence: 'every Sunday' },
]

export type HealthState = 'ok' | 'stale' | 'failed' | 'never'

export type Health = {
  destination: Destination
  label: string
  cadence: string
  state: HealthState
  lastOk: BackupRun | null
  latest: BackupRun | null
  ageHours: number | null
  message: string
}

// The codes scripts write (ops/backup/*.sh failure-code, workflow details), in words for people.
const FAILURE_TEXT: Record<string, string> = {
  connection_failed: 'the database could not be reached or refused the login',
  database_too_big: 'the database is over the size limit set for backups',
  dump_too_big: 'the dump is over the size limit set for backups',
  database_busy: 'the data kept changing while it was being copied',
  dump_failed: 'the database dump failed',
  dump_unreadable: 'the dump could not be read back',
  encrypt_failed: 'encryption failed',
  upload_failed: 'the upload failed',
  push_failed: 'the push to the repository failed',
  media_mirror_failed: 'the dump was copied, but some media files could not be',
}

export function failureText(detail: string | null): string {
  if (!detail) return 'the reason was not recorded'
  return FAILURE_TEXT[detail] ?? `code “${detail.replace(/[^\w .:-]/g, '').slice(0, 60)}”`
}

export function formatAge(hours: number): string {
  if (hours < 1) return 'less than an hour ago'
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} days ago`
}

const ageOf = (run: BackupRun, now: Date) => (now.getTime() - Date.parse(run.taken_at)) / 3_600_000

export function backupHealth(runs: readonly BackupRun[], now: Date): Health[] {
  return DESTINATIONS.map(({ id, label, staleAfterHours, cadence }) => {
    const mine = runs.filter((r) => r.destination === id).sort((a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at) || b.id - a.id)
    const latest = mine[0] ?? null
    const lastOk = mine.find((r) => r.ok) ?? null
    const base = { destination: id, label, cadence, lastOk, latest, ageHours: lastOk ? ageOf(lastOk, now) : null }
    if (!latest) return { ...base, state: 'never', message: 'No backup has been recorded yet.' }
    if (!latest.ok) {
      return {
        ...base,
        state: 'failed',
        message: `The latest attempt failed: ${failureText(latest.detail)}.${lastOk ? ` The last good one was ${formatAge(ageOf(lastOk, now))}.` : ' There is no good one yet.'}`,
      }
    }
    const age = ageOf(latest, now)
    if (age > staleAfterHours) {
      return { ...base, state: 'stale', message: `The newest backup is ${formatAge(age)}; one is expected ${cadence}.` }
    }
    return { ...base, state: 'ok', message: `Last backup ${formatAge(age)}.` }
  })
}

// One sentence for the top of the panel: the worst thing, or all well.
export function overallMessage(health: readonly Health[]): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  const r2 = health.find((h) => h.destination === 'r2')
  if (r2 && (r2.state === 'failed' || r2.state === 'stale')) return { tone: 'bad', text: `The daily backup needs attention. ${r2.message}` }
  if (r2?.state === 'never') return { tone: 'warn', text: 'No backup has run yet. Until one has, the club has no recovery copy of its data.' }
  const other = health.find((h) => h.state === 'failed' || h.state === 'stale')
  if (other) return { tone: 'warn', text: `${other.label}: ${other.message}` }
  return { tone: 'ok', text: 'Backups are running.' }
}

export function describeRun(run: BackupRun): string {
  const parts = [run.size_bytes !== null ? formatBytes(run.size_bytes) : null, run.row_count !== null ? `${run.row_count.toLocaleString('en-GB')} rows` : null]
  return parts.filter(Boolean).join(' · ')
}
