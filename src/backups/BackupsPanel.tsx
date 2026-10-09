import { useState } from 'react'
import { formatInstant } from '../lib/dates.ts'
import { requestBackupDownload, useBackupRuns } from '../data/useBackups.ts'
import { buttonSecondary } from '../ui/buttons.ts'
import { ActionError, ErrorState, LoadingState } from '../ui/states.tsx'
import { backupHealth, describeRun, overallMessage, type Health } from './status.ts'

const TONE = {
  ok: 'border-green-300 bg-green-50 text-green-900',
  warn: 'border-amber-300 bg-amber-50 text-amber-950',
  bad: 'border-red-300 bg-red-50 text-red-900',
} as const
const STATE_LABEL = { ok: 'OK', stale: 'Overdue', failed: 'Failed', never: 'Not yet' } as const
const STATE_CHIP = {
  ok: 'bg-green-100 text-green-900',
  stale: 'bg-red-100 text-red-900',
  failed: 'bg-red-100 text-red-900',
  never: 'bg-slate-100 text-slate-700',
} as const

// Settings → Backups (President, Vice President, Developer): what the daily and weekly backups did, and the
// newest encrypted file to download. Read-only: backups are made and recorded by the scheduled workflow.
export function BackupsPanel({ now = new Date() }: { now?: Date }) {
  const runs = useBackupRuns()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [saved, setSaved] = useState<{ name: string; sha256: string } | null>(null)

  if (runs.error) return <ErrorState title="Could not load the backup status" error={runs.error} onRetry={() => void runs.refetch()} />
  if (runs.isPending) return <LoadingState label="Loading backup status…" />

  const health = backupHealth(runs.data, now)
  const overall = overallMessage(health)

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const file = await requestBackupDownload()
      const a = document.createElement('a')
      a.href = file.url
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setSaved({ name: file.name, sha256: file.sha256 })
    } catch (e) {
      setError(e instanceof Error ? e : new Error('The download failed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="backups-panel">
      <p role={overall.tone === 'ok' ? 'status' : 'alert'} className={`rounded border p-3 text-sm ${TONE[overall.tone]}`} data-testid="backups-overall">
        {overall.text}
      </p>

      <ul className="space-y-2">
        {health.map((h) => (
          <DestinationCard key={h.destination} health={h} />
        ))}
      </ul>

      <div className="rounded border border-slate-200 bg-white p-3">
        <h3 className="text-sm font-medium text-slate-900">Download the newest backup</h3>
        <p className="mt-1 text-xs text-slate-600">
          The file is encrypted. Only the key holders (President, Vice President, Developers) can open it, with the private
          key they generated themselves — the app does not have it.
        </p>
        <div className="mt-2">
          <button type="button" className={buttonSecondary} onClick={() => void download()} disabled={busy || !health[0].lastOk} data-testid="backup-download">
            {busy ? 'Preparing…' : 'Download latest backup'}
          </button>
        </div>
        <ActionError error={error} className="mt-2" />
        {saved && (
          <p className="mt-2 text-xs break-all text-slate-700" role="status" data-testid="backup-saved">
            Saving <span className="font-mono">{saved.name}</span>. Check it with <span className="font-mono">sha256sum</span>: it should
            start <span className="font-mono">{saved.sha256.slice(0, 16)}…</span> (full: <span className="font-mono">{saved.sha256}</span>).
          </p>
        )}
      </div>
    </div>
  )
}

function DestinationCard({ health: h }: { health: Health }) {
  const run = h.lastOk
  return (
    <li className="rounded border border-slate-200 bg-white p-3" data-testid={`backup-${h.destination}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-slate-900">{h.label}</h3>
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATE_CHIP[h.state]}`}>{STATE_LABEL[h.state]}</span>
      </div>
      <p className="mt-1 text-sm text-slate-700">{h.message}</p>
      {run && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
          <div>
            <dt className="inline font-medium">Taken: </dt>
            <dd className="inline">{formatInstant(run.taken_at)}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Size: </dt>
            <dd className="inline">{describeRun(run)}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Database version: </dt>
            <dd className="inline font-mono">{run.migration_version}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Readable by: </dt>
            <dd className="inline">{run.recipients.length} key{run.recipients.length === 1 ? '' : 's'}</dd>
          </div>
          <div className="sm:col-span-2 break-all">
            <dt className="inline font-medium">Checksum (sha256): </dt>
            <dd className="inline font-mono" data-testid={`backup-sha-${h.destination}`}>{run.sha256}</dd>
          </div>
          {run.recipients.length > 0 && (
            <div className="sm:col-span-2 break-all">
              <dt className="inline font-medium">Key fingerprints: </dt>
              <dd className="inline font-mono">{run.recipients.join(' ')}</dd>
            </div>
          )}
        </dl>
      )}
    </li>
  )
}
