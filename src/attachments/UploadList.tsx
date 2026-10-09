import { buttonQuiet } from '../ui/buttons.ts'
import { isActive, type UploadItem } from './uploadStore.ts'

const STAGE_LABEL: Record<UploadItem['stage'], string> = {
  waiting: 'Waiting',
  preparing: 'Compressing',
  uploading: 'Uploading',
  finishing: 'Finishing',
  done: 'Added',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

// The uploads of this task in two visible stages — compressing, then uploading — each with its own
// progress, Cancel while running, Try again after a failure (ATT-12).
export function UploadList({
  items,
  onCancel,
  onRetry,
  onDismiss,
}: {
  items: UploadItem[]
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
}) {
  if (items.length === 0) return null
  const compressingVideo = items.some((it) => it.stage === 'preparing' && it.kind === 'video')
  return (
    <div className="mt-2 space-y-1.5" data-testid="upload-list">
      {compressingVideo && (
        <p className="rounded bg-blue-50 p-2 text-xs text-blue-900">
          Keep this screen open while the video is compressed — a phone pauses the work when it is locked or
          another app is opened. Closing these details is fine.
        </p>
      )}
      <ul className="space-y-1.5">
        {items.map((it) => {
          const running = isActive(it.stage)
          const pct = Math.round(it.progress * 100)
          const showBar = it.stage === 'preparing' || it.stage === 'uploading'
          return (
            <li key={it.id} className="rounded border border-slate-200 bg-white p-2 text-sm" data-testid={`upload-${it.stage}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-slate-800" title={it.fileName}>
                  {it.fileName}
                </span>
                <span
                  className={`text-xs ${it.stage === 'failed' ? 'text-red-800' : it.stage === 'done' ? 'text-green-700' : 'text-slate-600'}`}
                  role={it.stage === 'failed' || it.stage === 'done' ? 'status' : undefined}
                >
                  {STAGE_LABEL[it.stage]}
                  {showBar ? ` ${pct}%` : ''}
                </span>
                {running ? (
                  <button type="button" className={buttonQuiet} onClick={() => onCancel(it.id)} aria-label={`Cancel upload of ${it.fileName}`}>
                    Cancel
                  </button>
                ) : (
                  <>
                    {(it.stage === 'failed' || it.stage === 'cancelled') && (
                      <button type="button" className={buttonQuiet} onClick={() => onRetry(it.id)} aria-label={`Try again: ${it.fileName}`}>
                        Try again
                      </button>
                    )}
                    <button type="button" className={buttonQuiet} onClick={() => onDismiss(it.id)} aria-label={`Dismiss ${it.fileName}`}>
                      Dismiss
                    </button>
                  </>
                )}
              </div>
              {showBar && (
                <div
                  role="progressbar"
                  aria-label={`${STAGE_LABEL[it.stage]} ${it.fileName}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  className="mt-1 h-1.5 overflow-hidden rounded bg-slate-200"
                >
                  <div className={`h-full ${it.stage === 'preparing' ? 'bg-amber-500' : 'bg-slate-700'} transition-[width]`} style={{ width: `${pct}%` }} />
                </div>
              )}
              {it.error && <p className="mt-1 text-xs text-red-800">{it.error}</p>}
              {it.note && <p className="mt-1 text-xs text-amber-900">{it.note}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
