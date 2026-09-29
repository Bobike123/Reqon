import { useState, type FormEvent } from 'react'
import { checkBookUrl, checkStoragePath } from '../../book/source.ts'
import {
  useRegulationDocument,
  useSaveRegulationDocument,
  type RegulationDocument,
} from '../../data/useRegulationDocument.ts'
import { useSeason } from '../../season/context.ts'
import { ActionError, ErrorState, LoadingState } from '../../ui/states.tsx'

const inputClass =
  'mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// Where the Requirements Book document lives, for the regulations edition this
// season reads. Administrators only (the caller decides who sees it, and the
// database refuses everyone else). Two ways to say where: a public https link,
// or a file in the private "regulations" bucket. Never a local path, and never a
// signed link — a private file gets a short-lived one each time it is opened.
export function BookSettings() {
  const season = useSeason()
  const regsRef = season.status === 'ready' ? (season.season.regs_ref ?? null) : null
  const doc = useRegulationDocument(regsRef)

  if (!regsRef) {
    return (
      <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        The current season has no regulations edition set, so there is no Requirements Book to configure.
      </p>
    )
  }
  if (doc.isLoading) return <LoadingState label="Loading the Requirements Book source…" />
  if (doc.error) {
    return <ErrorState title="Could not load the Requirements Book source" error={doc.error} onRetry={() => void doc.refetch()} />
  }
  // Keyed on the server's last-change stamp so the form re-initialises when the
  // stored value changes (a save, or another administrator's edit) without an
  // effect copying props into state.
  return <BookSettingsForm key={doc.data?.updated_at ?? 'none'} regsRef={regsRef} doc={doc.data ?? null} />
}

function BookSettingsForm({ regsRef, doc }: { regsRef: string; doc: RegulationDocument | null }) {
  const save = useSaveRegulationDocument()
  const [title, setTitle] = useState(doc?.title ?? '')
  const [url, setUrl] = useState(doc?.url ?? '')
  const [storagePath, setStoragePath] = useState(doc?.storage_path ?? '')
  const [pageOffset, setPageOffset] = useState(String(doc?.page_offset ?? 0))
  const [pageCount, setPageCount] = useState(doc?.page_count != null ? String(doc.page_count) : '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (save.isPending) return
    setSaved(false)

    const found: Record<string, string> = {}
    const urlValue = url.trim()
    const pathValue = storagePath.trim()
    if (urlValue && pathValue) found.source = 'Use a link or a stored file, not both.'
    if (urlValue) {
      const check = checkBookUrl(urlValue)
      if (!check.ok) found.url = check.reason
    }
    if (pathValue) {
      const check = checkStoragePath(pathValue)
      if (!check.ok) found.storagePath = check.reason
    }
    const offset = Number(pageOffset)
    if (pageOffset.trim() === '' || !Number.isInteger(offset) || offset < -500 || offset > 500) {
      found.pageOffset = 'Enter a whole number between -500 and 500 (0 if the printed and PDF page numbers match).'
    }
    const countValue = pageCount.trim()
    const count = countValue === '' ? null : Number(countValue)
    if (count !== null && (!Number.isInteger(count) || count < 1 || count > 99999)) {
      found.pageCount = 'Enter a whole number of pages, or leave it empty if unknown.'
    }
    setErrors(found)
    if (Object.keys(found).length > 0) return

    try {
      await save.mutateAsync({
        regsRef,
        edition: doc?.edition ?? null,
        title: title.trim() || null,
        url: urlValue || null,
        storagePath: pathValue || null,
        pageOffset: offset,
        pageCount: count,
      })
      setSaved(true)
    } catch {
      // Refused or failed: the message is shown below and what was typed stays.
    }
  }

  const configured = Boolean(doc?.url || doc?.storage_path)

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-3" noValidate>
      <p className="text-sm text-slate-800" data-testid="book-config-status">
        Edition <strong>{regsRef}</strong>:{' '}
        {configured ? 'a document is configured.' : 'no document is configured yet.'}
      </p>
      <p className="mt-0.5 mb-2 text-xs text-slate-600">
        Give either a public https link or the path of a file uploaded to the private “regulations” storage
        bucket. Page numbers in the Register are the printed ones; the offset converts them to the PDF’s own
        page index.
      </p>

      <label className="block text-xs font-medium text-slate-600" htmlFor="book-title">
        Title (optional)
      </label>
      <input id="book-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />

      <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="book-url">
        Link (https)
      </label>
      <input
        id="book-url"
        type="url"
        inputMode="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://…"
        aria-invalid={Boolean(errors.url || errors.source)}
        aria-describedby={errors.url ? 'book-url-error' : undefined}
        className={inputClass}
      />
      {errors.url && (
        <p id="book-url-error" role="alert" className="mt-0.5 text-xs text-red-800">
          {errors.url}
        </p>
      )}

      <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="book-path">
        Or a file in the private bucket
      </label>
      <input
        id="book-path"
        value={storagePath}
        onChange={(e) => setStoragePath(e.target.value)}
        placeholder="ms2627/regulations.pdf"
        aria-invalid={Boolean(errors.storagePath || errors.source)}
        aria-describedby={errors.storagePath ? 'book-path-error' : undefined}
        className={inputClass}
      />
      {errors.storagePath && (
        <p id="book-path-error" role="alert" className="mt-0.5 text-xs text-red-800">
          {errors.storagePath}
        </p>
      )}
      {errors.source && (
        <p role="alert" className="mt-0.5 text-xs text-red-800">
          {errors.source}
        </p>
      )}

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="book-offset">
            Page offset
          </label>
          <input
            id="book-offset"
            inputMode="numeric"
            value={pageOffset}
            onChange={(e) => setPageOffset(e.target.value)}
            aria-invalid={Boolean(errors.pageOffset)}
            aria-describedby={errors.pageOffset ? 'book-offset-error' : undefined}
            className={inputClass}
          />
          {errors.pageOffset && (
            <p id="book-offset-error" role="alert" className="mt-0.5 text-xs text-red-800">
              {errors.pageOffset}
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="book-pages">
            Number of pages (optional)
          </label>
          <input
            id="book-pages"
            inputMode="numeric"
            value={pageCount}
            onChange={(e) => setPageCount(e.target.value)}
            aria-invalid={Boolean(errors.pageCount)}
            aria-describedby={errors.pageCount ? 'book-pages-error' : undefined}
            className={inputClass}
          />
          {errors.pageCount && (
            <p id="book-pages-error" role="alert" className="mt-0.5 text-xs text-red-800">
              {errors.pageCount}
            </p>
          )}
        </div>
      </div>

      <ActionError error={save.error} className="mt-2" />
      {saved && !save.error && (
        <p role="status" className="mt-2 text-sm text-emerald-800">
          Saved.
        </p>
      )}

      <button
        type="submit"
        disabled={save.isPending}
        className="mt-3 min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
      >
        {save.isPending ? 'Saving…' : 'Save Requirements Book source'}
      </button>
    </form>
  )
}
