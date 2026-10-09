import { useEffect, useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { canManageAttachment, type AttachmentPermissions } from '../auth/permissions.ts'
import { queryKeys } from '../data/queryKeys.ts'
import { type Attachment, fetchAttachmentUrls, useDeleteAttachment, useSetAttachmentCaption } from '../data/useAttachments.ts'
import { formatInstant } from '../lib/dates.ts'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError } from '../ui/states.tsx'
import { formatBytes, formatDuration } from './rules.ts'
import { VideoPlayer } from './VideoPlayer.tsx'

const ICON_BUTTON =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded text-lg text-white hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none disabled:opacity-30'

// Saves a file under its original name: the signed link carries Content-Disposition: attachment, so the
// browser downloads instead of navigating away.
async function download(id: string) {
  const { urls } = await fetchAttachmentUrls([id], 'original', true)
  const url = urls[id]
  if (!url) throw new Error('This file is no longer available.')
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function FullPhoto({ file, thumbUrl }: { file: Attachment; thumbUrl: string | null }) {
  const original = useQuery({
    queryKey: queryKeys.attachmentUrls('original', [file.id]),
    queryFn: () => fetchAttachmentUrls([file.id], 'original'),
    staleTime: 45 * 60 * 1000,
  })
  const src = original.data?.urls[file.id] ?? thumbUrl
  if (!src) return <p className="text-sm text-slate-300">Loading…</p>
  return (
    <img
      src={src}
      alt={file.caption ?? file.original_name}
      className="max-h-[70dvh] max-w-full rounded object-contain"
      // An expired link after a long pause: fetch a fresh one.
      onError={() => {
        if (!original.isFetching) void original.refetch()
      }}
      data-testid="lightbox-photo"
    />
  )
}

// The single open file, full screen on a phone. One player at a time: closing it (or moving to the next
// file) unmounts the <video>, which stops it and releases its buffers.
export function Lightbox({
  taskId,
  files,
  index,
  thumbUrls,
  perms,
  nameOf,
  onIndex,
  onClose,
}: {
  taskId: string
  files: Attachment[]
  index: number
  thumbUrls: Record<string, string>
  perms: AttachmentPermissions
  nameOf: (id: string | null) => string
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const file = files[index]
  const dialog = useRef<HTMLDialogElement>(null)
  const uid = useId()
  const remove = useDeleteAttachment(taskId)
  const caption = useSetAttachmentCaption(taskId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<Error | null>(null)
  const [downloading, setDownloading] = useState(false)
  const manage = canManageAttachment(perms, file.uploaded_by)

  // Moving to another file starts its controls fresh.
  const [seen, setSeen] = useState(file.id)
  if (seen !== file.id) {
    setSeen(file.id)
    setConfirmDelete(false)
    setDraft(null)
    setDownloadError(null)
    remove.reset()
    caption.reset()
  }

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    el.showModal()
    return () => {
      el.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const go = (step: number) => {
    const next = index + step
    if (next >= 0 && next < files.length) onIndex(next)
  }

  const meta = [
    formatBytes(file.size_bytes),
    file.duration_ms !== null ? formatDuration(file.duration_ms) : null,
    `added by ${nameOf(file.uploaded_by)}`,
    formatInstant(file.created_at),
  ].filter(Boolean)

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${uid}-title`}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-slate-950 p-0 text-white backdrop:bg-black/80 sm:m-auto sm:h-[min(56rem,95dvh)] sm:w-[min(64rem,95vw)] sm:rounded-xl"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'VIDEO') return
        if (e.key === 'ArrowLeft') go(-1)
        if (e.key === 'ArrowRight') go(1)
      }}
      data-testid="attachment-lightbox"
    >
      <div className="flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <header className="flex items-center gap-2 border-b border-white/10 px-2 py-1">
          <h2 id={`${uid}-title`} className="min-w-0 flex-1 truncate px-2 text-sm font-medium">
            {file.original_name}
          </h2>
          <span className="text-xs text-slate-400 tabular-nums">
            {index + 1} / {files.length}
          </span>
          <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label="Close" data-testid="lightbox-close">
            ✕
          </button>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center p-2">
          {file.kind === 'photo' && <FullPhoto key={file.id} file={file} thumbUrl={thumbUrls[file.id] ?? null} />}
          {file.kind === 'video' && file.playable && (
            <VideoPlayer key={file.id} attachmentId={file.id} poster={thumbUrls[file.id] ?? null} name={file.original_name} />
          )}
          {file.kind === 'video' && !file.playable && (
            <div className="max-w-md space-y-3 text-center">
              {thumbUrls[file.id] && <img src={thumbUrls[file.id]} alt="" className="mx-auto max-h-[40dvh] rounded" />}
              <p className="text-sm text-slate-200">
                This video is stored as the original file: the browser that added it could not compress it. Download it to
                watch it.
              </p>
            </div>
          )}
          {file.kind === 'document' && (
            <div className="space-y-2 text-center">
              <span className="inline-block rounded bg-red-700 px-2 py-1 text-sm font-bold">PDF</span>
              <p className="text-sm text-slate-200">Download the document to read it.</p>
            </div>
          )}
          {files.length > 1 && (
            <>
              <button type="button" className={`${ICON_BUTTON} absolute top-1/2 left-1 -translate-y-1/2 bg-black/40`} onClick={() => go(-1)} disabled={index === 0} aria-label="Previous file">
                ‹
              </button>
              <button
                type="button"
                className={`${ICON_BUTTON} absolute top-1/2 right-1 -translate-y-1/2 bg-black/40`}
                onClick={() => go(1)}
                disabled={index === files.length - 1}
                aria-label="Next file"
              >
                ›
              </button>
            </>
          )}
        </div>

        <footer className="space-y-2 overflow-y-auto border-t border-white/10 bg-white p-3 text-slate-900 sm:max-h-[40%]">
          {draft === null ? (
            <p className="text-sm whitespace-pre-line" data-testid="lightbox-caption">
              {file.caption ?? <span className="text-slate-500 italic">No caption.</span>}
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                caption.mutate({ attachmentId: file.id, caption: draft }, { onSuccess: () => setDraft(null) })
              }}
              className="space-y-2"
            >
              <label htmlFor={`${uid}-caption`} className="block text-xs font-medium text-slate-700">
                Caption
              </label>
              <textarea
                id={`${uid}-caption`}
                rows={2}
                maxLength={500}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={buttonPrimary} disabled={caption.isPending}>
                  {caption.isPending ? 'Saving…' : 'Save caption'}
                </button>
                <button type="button" className={buttonSecondary} onClick={() => setDraft(null)} disabled={caption.isPending}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          <ActionError error={caption.error} />
          <p className="text-xs text-slate-600">{meta.join(' · ')}</p>

          {confirmDelete ? (
            <div role="alertdialog" aria-label="Delete this file" className="rounded border border-slate-300 bg-slate-50 p-2">
              <p className="text-sm">
                Delete “{file.original_name}”? It disappears for everyone now. The file itself is kept for 30 days in case it
                has to be restored, then removed.
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  className={buttonDanger}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(file.id, { onSuccess: () => onClose() })}
                  data-testid="lightbox-delete-confirm"
                >
                  {remove.isPending ? 'Deleting…' : 'Yes, delete it'}
                </button>
                <button type="button" className={buttonSecondary} onClick={() => setConfirmDelete(false)} disabled={remove.isPending}>
                  Keep it
                </button>
              </div>
              <ActionError error={remove.error} className="mt-2" />
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonSecondary}
                disabled={downloading}
                onClick={() => {
                  setDownloading(true)
                  setDownloadError(null)
                  download(file.id)
                    .catch((e: unknown) => setDownloadError(e instanceof Error ? e : new Error('The download failed.')))
                    .finally(() => setDownloading(false))
                }}
                data-testid="lightbox-download"
              >
                {downloading ? 'Preparing…' : 'Download'}
              </button>
              {manage && draft === null && (
                <button type="button" className={buttonSecondary} onClick={() => setDraft(file.caption ?? '')}>
                  {file.caption ? 'Edit caption' : 'Add caption'}
                </button>
              )}
              {manage && (
                <button type="button" className={buttonSecondary} onClick={() => setConfirmDelete(true)} data-testid="lightbox-delete">
                  Delete…
                </button>
              )}
            </div>
          )}
          <ActionError error={downloadError} />
          {!manage && perms.actorId !== null && (
            <p className="text-xs text-slate-500">Who added it, the department&apos;s Head or above can delete it.</p>
          )}
        </footer>
      </div>
    </dialog>
  )
}
