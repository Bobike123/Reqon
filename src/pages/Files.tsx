import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AttachmentTile } from '../attachments/AttachmentTile.tsx'
import { attachmentsEnabled } from '../attachments/flag.ts'
import { Lightbox } from '../attachments/Lightbox.tsx'
import { countByKind, filterFiles, KIND_FILTERS, parseKind } from '../attachments/library.ts'
import { formatBytes } from '../attachments/rules.ts'
import { useAttachmentThumbUrls, useSeasonAttachments } from '../data/useAttachments.ts'
import { useMembers } from '../data/useMembers.ts'
import { formatInstantDay } from '../lib/dates.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import { EmptyState, ErrorState, LoadingState } from '../ui/states.tsx'

const FIELD =
  'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// Viewing from here never changes a file: deleting and captions stay on the task, where the right to do it is
// worked out for that task.
const VIEW_ONLY = { canUpload: false, canManageAll: false, actorId: null } as const

// Every photo, PDF and video attached to a task this season, in one place. Newest first.
export default function Files() {
  if (!attachmentsEnabled()) {
    return (
      <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
        <PageHeader title="Files" description="Every photo, PDF and video attached to a task." tutorialId="files-overview" />
        <EmptyState title="Files are not switched on">Ask a Developer to turn on file attachments.</EmptyState>
      </main>
    )
  }
  return <FilesLibrary />
}

function FilesLibrary() {
  const [params, setParams] = useSearchParams()
  const kind = parseKind(params.get('kind'))
  const query = params.get('q') ?? ''
  const list = useSeasonAttachments()
  const all = useMemo(() => list.data ?? [], [list.data])
  const thumbs = useAttachmentThumbUrls(useMemo(() => all.map((f) => f.id), [all]))
  const members = useMembers()
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.full_name])), [members.data])
  const counts = useMemo(() => countByKind(all), [all])
  const shown = useMemo(() => filterFiles(all, kind, query), [all, kind, query])
  const [openId, setOpenId] = useState<string | null>(null)
  const openIndex = openId === null ? -1 : shown.findIndex((f) => f.id === openId)

  const refetchedThumbs = useRef<number | null>(null)
  const onThumbError = () => {
    if (thumbs.isFetching || refetchedThumbs.current === thumbs.dataUpdatedAt) return
    refetchedThumbs.current = thumbs.dataUpdatedAt
    void thumbs.refetch()
  }

  // Two quick changes (a filter, then a typed word) must not overwrite each other: the router hands every update the
  // address of the LAST RENDER, so the newest address is kept here and used for the next change.
  const latest = useRef(params)
  latest.current = params
  const set = (next: { kind?: string; q?: string }) => {
    const p = new URLSearchParams(latest.current)
    for (const [key, value] of Object.entries(next)) {
      if (value && value !== 'all') p.set(key, value)
      else p.delete(key)
    }
    latest.current = p
    setParams(p, { replace: true })
  }

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader title="Files" description="Every photo, PDF and video attached to a task." tutorialId="files-overview" />

      {list.error ? (
        <ErrorState title="Could not load the files" error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <LoadingState label="Loading files…" />
      ) : all.length === 0 ? (
        <EmptyState title="No files yet">Attach a photo, PDF or video to a task and it appears here.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
              {KIND_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={kind === f.id}
                  onClick={() => set({ kind: f.id })}
                  className={`min-h-11 rounded border px-3 py-1.5 text-sm sm:min-h-0 ${
                    kind === f.id ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  {f.label} <span className="tabular-nums opacity-70">{counts[f.id]}</span>
                </button>
              ))}
            </div>
            <label className="block min-w-48 flex-1 text-xs font-medium text-slate-600">
              Search by file or task
              <input type="search" value={query} onChange={(e) => set({ q: e.target.value })} className={FIELD} data-testid="files-search" />
            </label>
          </div>

          <p role="status" className="mt-3 text-sm text-slate-600" data-testid="files-count">
            {shown.length === all.length ? `${all.length} file${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} files`}
          </p>

          {shown.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 italic">No file matches. Clear the search or choose All.</p>
          ) : (
            <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Files">
              {shown.map((file) => (
                <li key={file.id} className="min-w-0" data-testid={`file-card-${file.id}`}>
                  <AttachmentTile
                    file={file}
                    thumbUrl={thumbs.data?.urls[file.id] ?? null}
                    thumbsFailed={thumbs.isError}
                    onOpen={() => setOpenId(file.id)}
                    onThumbError={onThumbError}
                  />
                  <p className="mt-1 truncate text-sm font-medium text-slate-900" title={file.original_name}>
                    {file.original_name}
                  </p>
                  <p className="truncate text-xs text-slate-600">
                    <Link to={`/board?task=${file.task_id}`} className="underline underline-offset-2 hover:text-slate-900">
                      {file.task_title}
                    </Link>
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {formatBytes(file.size_bytes)} · {formatInstantDay(file.created_at)}
                    {file.uploaded_by ? ` · ${names.get(file.uploaded_by) ?? 'Former team member'}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {openIndex >= 0 && (
        <Lightbox
          taskId={shown[openIndex].task_id}
          files={shown}
          index={openIndex}
          thumbUrls={thumbs.data?.urls ?? {}}
          perms={VIEW_ONLY}
          nameOf={(id) => (id ? (names.get(id) ?? 'Former team member') : 'Former team member')}
          onIndex={(i) => setOpenId(shown[i]?.id ?? null)}
          onClose={() => setOpenId(null)}
        />
      )}
    </main>
  )
}
