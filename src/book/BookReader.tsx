import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { usePermissions } from '../auth/usePermissions.ts'
import { useBookFile, useRegulationDocument } from '../data/useRegulationDocument.ts'
import { useSeason } from '../season/context.ts'
import { buttonSecondary } from '../ui/buttons.ts'
import { ErrorState, LoadingState } from '../ui/states.tsx'
import { embedUrl } from './source.ts'

// pdf.js is fetched only when a reader actually opens.
const PdfPageView = lazy(() => import('./PdfPageView.tsx'))

const linkButton =
  'inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// THE Requirements Book reader: one implementation for the /book screen and the
// reader pane inside the Register. It resolves the season's edition to its
// configured document (Settings — never a path in the code), draws the requested
// PRINTED page (the edition's page_offset turns it into the PDF's own page), and
// always offers the document in a new tab as the fallback.
//
// `page` is controlled by the caller: the /book screen keeps it in ?page=, the
// Register keeps it with the selected rule. The reader's own Previous/Next/Go
// controls ask the caller to change it.
export function BookReader({
  page,
  onPageChange,
  ruleRef,
  note,
  notice,
  compact = false,
  toolbarExtra,
}: {
  // The printed page to show, or null for the start of the document.
  page: number | null
  onPageChange: (page: number) => void
  // The rule being read (display only).
  ruleRef?: string | null
  // Why no page is shown for that rule ("Page not recorded", …), if so.
  note?: string | null
  // A problem with the requested page itself (out of range, not a number).
  notice?: string | null
  compact?: boolean
  toolbarExtra?: ReactNode
}) {
  const season = useSeason()
  const regsRef = season.status === 'ready' ? (season.season.regs_ref ?? null) : null
  const { canAdminister } = usePermissions()
  const doc = useRegulationDocument(regsRef)
  const file = useBookFile(regsRef ? doc.data : null)
  const [draft, setDraft] = useState<string | null>(null)

  // The open document, fixed per DOCUMENT: a private file's link is re-signed
  // in the background, and swapping the address under an open document would
  // reload it and lose the reader's place. A different document — another
  // edition (a season switch) or a source reconfigured in Settings — replaces
  // it, with its own page count and errors (finding F14-13: the first address
  // used to stay forever, so a new edition was labelled but the old PDF drawn).
  const identity = regsRef && doc.data ? `${doc.data.regs_ref}|${doc.data.url ?? ''}|${doc.data.storage_path ?? ''}` : null
  const [viewer, setViewer] = useState<{ identity: string; url: string; attempt: number; pages: number | null; error: string | null } | null>(null)
  if (file.data?.status === 'ready' && identity && viewer?.identity !== identity) {
    setViewer({ identity, url: file.data.url, attempt: 0, pages: null, error: null })
  }
  const current = viewer && viewer.identity === identity ? viewer : null
  const pdfPages = current?.pages ?? null
  const readError = current?.error ?? null
  const setPdfPages = (pages: number) => setViewer((v) => (v && v.identity === identity ? { ...v, pages } : v))
  const setReadError = (error: string) => setViewer((v) => (v && v.identity === identity ? { ...v, error } : v))
  // Try again with a freshly signed address.
  const retry = () =>
    setViewer((v) =>
      v && file.data?.status === 'ready' ? { ...v, url: file.data.url, attempt: v.attempt + 1, error: null } : v,
    )

  const settingsHint = canAdminister ? (
    <>
      {' '}
      <Link to="/settings" className="underline underline-offset-2">
        Set it up in Settings
      </Link>
      .
    </>
  ) : (
    ' Ask the President or Vice President to set it up in Settings.'
  )

  if (!regsRef) {
    return (
      <p role="status" className="rounded border border-slate-300 bg-slate-50 p-4 text-sm text-slate-800" data-testid="book-not-configured">
        This season has no regulations edition set, so there is no Requirements Book to show.{settingsHint}
      </p>
    )
  }
  if (doc.error) {
    return <ErrorState title="Could not load the Requirements Book" error={doc.error} onRetry={() => void doc.refetch()} />
  }
  if (doc.isLoading || file.isLoading) return <LoadingState label="Opening the Requirements Book…" />
  if (file.error) {
    return (
      <div data-testid="book-unavailable">
        <ErrorState title="The Requirements Book could not be opened" error={file.error} onRetry={() => void doc.refetch()} />
        <p className="mt-3 text-sm text-slate-700">
          The document is configured, but the file could not be reached. It may have been moved or removed.
          {settingsHint}
        </p>
      </div>
    )
  }
  if (!file.data || file.data.status === 'none') {
    return (
      <p role="status" className="rounded border border-slate-300 bg-slate-50 p-4 text-sm text-slate-800" data-testid="book-not-configured">
        No Requirements Book is configured for {regsRef}.{settingsHint}
      </p>
    )
  }
  if (file.data.status === 'invalid') {
    return (
      <p role="alert" className="rounded border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950" data-testid="book-invalid">
        The Requirements Book for {regsRef} is configured with something that cannot be opened: {file.data.reason}
        {settingsHint}
      </p>
    )
  }

  const offset = doc.data?.page_offset ?? 0
  const printed = page ?? 1
  const index = Math.max(1, printed + offset)
  const known = pdfPages ?? doc.data?.page_count ?? null
  const lastPrinted = known !== null ? known - offset : null
  const openUrl = embedUrl(file.data.url, page, offset)
  const go = (next: number) => {
    setDraft(null)
    if (next < 1 || (lastPrinted !== null && next > lastPrinted)) return
    onPageChange(next)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="book-reader" data-page={printed}>
      {notice && (
        <p role="status" className="rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-950" data-testid="book-page-notice">
          {notice}
        </p>
      )}
      <p className="text-sm text-slate-700" data-testid="book-location">
        {ruleRef && (
          <>
            Rule <span className="font-mono font-semibold text-slate-900">{ruleRef}</span> ·{' '}
          </>
        )}
        {note ? `${note} — showing page ${printed}` : page !== null ? `Page ${page}` : 'The start of the book'}
        {offset !== 0 && ` (PDF page ${index})`}
        {` · ${regsRef}`}
      </p>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Page">
        <button type="button" className={buttonSecondary} onClick={() => go(printed - 1)} disabled={printed <= 1}>
          <span aria-hidden="true">←</span> Previous
        </button>
        <label className="flex items-center gap-1 text-sm text-slate-700">
          Page
          <input
            inputMode="numeric"
            value={draft ?? String(printed)}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft) go(Number(draft))
            }}
            onBlur={() => setDraft(null)}
            aria-describedby={lastPrinted !== null ? 'book-page-count' : undefined}
            className="min-h-11 w-16 rounded border border-slate-300 px-2 py-1 text-sm sm:min-h-0"
          />
        </label>
        {lastPrinted !== null && (
          <span id="book-page-count" className="text-sm text-slate-600">
            of {lastPrinted}
          </span>
        )}
        <button type="button" className={buttonSecondary} onClick={() => go(printed + 1)} disabled={lastPrinted !== null && printed >= lastPrinted}>
          Next <span aria-hidden="true">→</span>
        </button>
        <a href={openUrl} target="_blank" rel="noopener noreferrer" className={linkButton} data-testid="book-open-external">
          Open the PDF in a new tab
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {toolbarExtra}
        {file.data.external && <span className="text-xs text-slate-600">Hosted outside Reqon</span>}
      </div>

      {readError ? (
        <div role="alert" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950" data-testid="book-read-error">
          <p>The book could not be drawn here ({readError}). Try again, or use “Open the PDF in a new tab” to read it.</p>
          <button type="button" className={`${buttonSecondary} mt-2`} onClick={retry} data-testid="book-retry">
            Try again
          </button>
        </div>
      ) : (
        <div className={`overflow-auto rounded border border-slate-300 bg-slate-100 ${compact ? 'max-h-[70vh]' : 'max-h-[80vh]'}`}>
          <Suspense fallback={<LoadingState label="Loading the reader…" />}>
            <PdfPageView
              key={`${current?.identity ?? ''}#${current?.attempt ?? 0}`}
              url={current?.url ?? file.data.url}
              pageIndex={index}
              label={`Requirements Book, ${regsRef}, page ${printed}`}
              onDocument={setPdfPages}
              onError={setReadError}
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}
