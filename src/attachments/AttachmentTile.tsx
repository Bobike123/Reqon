import type { Attachment } from '../data/useAttachments.ts'
import { formatDuration } from './rules.ts'

// One square tile. Its size never depends on the file (aspect-square, object-cover), so a grid of
// tall phone videos and wide photos does not jump while thumbnails arrive (ATT-11). No <video> here.
export function AttachmentTile({
  file,
  thumbUrl,
  thumbsFailed,
  onOpen,
  onThumbError,
}: {
  file: Attachment
  thumbUrl: string | null
  thumbsFailed: boolean
  onOpen: () => void
  onThumbError: () => void
}) {
  const kindLabel = file.kind === 'video' ? (file.playable ? 'video' : 'video, download only') : file.kind === 'photo' ? 'photo' : 'PDF'
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${kindLabel}: ${file.original_name}`}
      className="group relative block aspect-square w-full overflow-hidden rounded border border-slate-200 bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:outline-none"
      data-testid={`attachment-tile-${file.id}`}
    >
      {file.kind === 'document' ? (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
          <span aria-hidden="true" className="rounded bg-red-700 px-1.5 py-0.5 text-[11px] font-bold text-white">
            PDF
          </span>
          <span className="line-clamp-3 text-[11px] break-all text-slate-700">{file.original_name}</span>
        </span>
      ) : thumbUrl ? (
        <img src={thumbUrl} alt="" loading="lazy" decoding="async" onError={onThumbError} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[11px] text-slate-500">
          {thumbsFailed ? 'Preview unavailable' : ''}
        </span>
      )}
      {file.kind === 'video' && (
        <>
          <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white">
              {file.playable ? '▶' : '↓'}
            </span>
          </span>
          {file.duration_ms !== null && (
            <span className="absolute right-1 bottom-1 rounded bg-black/65 px-1 text-[11px] text-white tabular-nums">
              {formatDuration(file.duration_ms)}
            </span>
          )}
        </>
      )}
    </button>
  )
}
