import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AttachmentPermissions } from '../auth/permissions.ts'
import { useMembers } from '../data/useMembers.ts'
import { type Attachment, useAttachmentThumbUrls, useRealtimeTaskAttachments, useTaskAttachments } from '../data/useAttachments.ts'
import { buttonSecondary } from '../ui/buttons.ts'
import { ErrorState } from '../ui/states.tsx'
import { AttachmentTile } from './AttachmentTile.tsx'
import { Lightbox } from './Lightbox.tsx'
import { PICKER_ACCEPT } from './rules.ts'
import { UploadList } from './UploadList.tsx'
import { bindUploadsToQueryClient, uploads } from './uploads.ts'
import { useUploads } from './uploadStore.ts'

const SECTION_HEADING = 'text-[11px] font-semibold tracking-wide text-slate-500 uppercase'

// Files on one task (docs/ultraplan Phase 3): a grid of fixed-size tiles (posters and thumbnails only —
// no <video> element until one is opened, ATT-11), the upload queue for this task, and one lightbox.
export default function AttachmentsPanel({ taskId, perms }: { taskId: string; perms: AttachmentPermissions }) {
  const queryClient = useQueryClient()
  useEffect(() => bindUploadsToQueryClient(queryClient), [queryClient])
  useRealtimeTaskAttachments(taskId)

  const list = useTaskAttachments(taskId)
  const files = useMemo(() => list.data ?? [], [list.data])
  const ids = useMemo(() => files.filter((f) => f.kind !== 'document').map((f) => f.id), [files])
  const thumbs = useAttachmentThumbUrls(ids)
  const members = useMembers()
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.full_name])), [members.data])
  const queue = useUploads(uploads, taskId)

  const [openId, setOpenId] = useState<string | null>(null)
  const openIndex = openId === null ? -1 : files.findIndex((f) => f.id === openId)
  const input = useRef<HTMLInputElement>(null)
  const uid = useId()

  // A thumbnail link can fail after the laptop slept past its expiry: ask for fresh links once per batch.
  const refetchedThumbs = useRef<number | null>(null)
  const onThumbError = () => {
    if (thumbs.isFetching || refetchedThumbs.current === thumbs.dataUpdatedAt) return
    refetchedThumbs.current = thumbs.dataUpdatedAt
    void thumbs.refetch()
  }

  const pick = (list: FileList | null) => {
    if (!list || list.length === 0) return
    uploads.add(taskId, Array.from(list))
    if (input.current) input.current.value = ''
  }

  return (
    <section aria-labelledby={`${uid}-h`} data-testid={`task-files-${taskId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${uid}-h`} className={SECTION_HEADING}>
          Files{files.length > 0 ? ` (${files.length})` : ''}
        </h4>
        {perms.canUpload && (
          <>
            <input
              ref={input}
              id={`${uid}-input`}
              type="file"
              multiple
              accept={PICKER_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => pick(e.target.files)}
              data-testid={`task-files-input-${taskId}`}
            />
            <button type="button" className={buttonSecondary} onClick={() => input.current?.click()} data-testid={`task-files-add-${taskId}`}>
              Add photos, videos or PDFs
            </button>
          </>
        )}
      </div>
      {perms.canUpload && (
        <p className="mt-0.5 text-xs text-slate-500">
          Photos are resized; videos are compressed to 720p (at most 3 minutes) on this device before upload.
        </p>
      )}

      <UploadList items={queue} onCancel={uploads.cancel} onRetry={uploads.retry} onDismiss={uploads.dismiss} />

      {list.error ? (
        <div className="mt-2">
          <ErrorState title="Could not load the files" error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : list.isPending ? (
        <p role="status" className="mt-1 text-sm text-slate-500">
          Loading files…
        </p>
      ) : files.length === 0 ? (
        <p className="mt-0.5 text-sm text-slate-500 italic">No files yet.</p>
      ) : (
        <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Files on this task">
          {files.map((file: Attachment) => (
            <li key={file.id} className="min-w-0">
              <AttachmentTile
                file={file}
                thumbUrl={thumbs.data?.urls[file.id] ?? null}
                thumbsFailed={thumbs.isError}
                onOpen={() => setOpenId(file.id)}
                onThumbError={onThumbError}
              />
            </li>
          ))}
        </ul>
      )}

      {openIndex >= 0 && (
        <Lightbox
          taskId={taskId}
          files={files}
          index={openIndex}
          thumbUrls={thumbs.data?.urls ?? {}}
          perms={perms}
          nameOf={(id) => (id ? (names.get(id) ?? 'Former team member') : 'Former team member')}
          onIndex={(i) => setOpenId(files[i]?.id ?? null)}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  )
}
