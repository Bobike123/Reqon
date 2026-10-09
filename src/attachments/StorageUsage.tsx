import { useAttachmentUsage } from '../data/useAttachments.ts'
import { ErrorState, LoadingState } from '../ui/states.tsx'
import { formatBytes } from './rules.ts'

const LABEL = { video: 'Videos', photo_document: 'Photos and documents' } as const

// Settings → File storage (ATT-16): how full each quota is. Shown to the President, the Vice President and
// Developers (attachment_usage() refuses everyone else). Counts files still waiting the 30-day purge.
export function StorageUsage() {
  const usage = useAttachmentUsage(true)
  if (usage.error) return <ErrorState title="Could not load the storage usage" error={usage.error} onRetry={() => void usage.refetch()} />
  if (usage.isPending) return <LoadingState label="Loading storage usage…" />
  return (
    <div className="space-y-3 rounded border border-slate-200 bg-white p-3" data-testid="storage-usage">
      {usage.data.map((row) => {
        const pct = row.quotaBytes > 0 ? Math.min(100, Math.round((row.usedBytes / row.quotaBytes) * 100)) : 0
        const tone = pct >= 90 ? 'bg-red-600' : pct >= 75 ? 'bg-amber-500' : 'bg-slate-700'
        return (
          <div key={row.quotaGroup}>
            <div className="flex justify-between text-sm">
              <span className="font-medium text-slate-800">{LABEL[row.quotaGroup]}</span>
              <span className="text-slate-600 tabular-nums">
                {formatBytes(row.usedBytes)} of {formatBytes(row.quotaBytes)} ({pct}%)
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={`${LABEL[row.quotaGroup]} storage used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="mt-1 h-2 overflow-hidden rounded bg-slate-200"
            >
              <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
      <p className="text-xs text-slate-500">
        Deleted files keep counting for 30 days, until they are removed from storage. Uploads stop when a group is full.
      </p>
    </div>
  )
}
