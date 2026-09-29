// The Requirements Book's rules, with no I/O: which document a season reads,
// which page a clause opens on, and what is safe to accept from configuration
// or from the address bar. The database enforces the same limits on what it
// stores (regulation_documents constraints); repeating them here gives the
// person configuring the book a message instead of a constraint error, and
// means a bad row that somehow got in is still not opened.

// ------------------------------------------------------------------ the source
export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string }

const MAX_URL = 2000

// https only, no embedded credentials, no whitespace. Anything else — http:,
// javascript:, data:, file: — is refused. A document link is opened in the
// person's own browser, so the scheme is the whole safety question.
export function checkBookUrl(raw: string): UrlCheck {
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'Enter a link.' }
  if (value.length > MAX_URL) return { ok: false, reason: `The link is longer than ${MAX_URL} characters.` }
  if (/\s/.test(value)) return { ok: false, reason: 'The link must not contain spaces.' }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'That is not a valid web address.' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'Only https:// links are accepted.' }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'The link must not contain a user name or password.' }
  }
  if (parsed.hostname === '') return { ok: false, reason: 'That is not a valid web address.' }
  return { ok: true, url: value }
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

// A path INSIDE the private "regulations" bucket: relative, no traversal, no
// scheme, no control characters. Never a filesystem path.
export function checkStoragePath(raw: string): PathCheck {
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'Enter a file path.' }
  if (value.length > 500) return { ok: false, reason: 'The path is longer than 500 characters.' }
  if (value.startsWith('/')) return { ok: false, reason: 'Use a path inside the bucket, without a leading /.' }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return { ok: false, reason: 'A path cannot start with a drive or scheme.' }
  if (/(^|\/)\.\.(\/|$)/.test(value)) return { ok: false, reason: 'A path cannot contain “..”.' }
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: 'A path cannot contain backslashes or control characters.' }
  return { ok: true, path: value }
}

export type DocumentRow = {
  regs_ref: string
  url: string | null
  storage_path: string | null
  page_offset: number
  page_count: number | null
}

export type DocumentSource =
  | { kind: 'none' }
  | { kind: 'url'; url: string }
  | { kind: 'storage'; path: string }
  // A row whose stored value fails validation today. Treated as unusable rather
  // than opened.
  | { kind: 'invalid'; reason: string }

export function documentSource(doc: Pick<DocumentRow, 'url' | 'storage_path'> | null | undefined): DocumentSource {
  if (!doc) return { kind: 'none' }
  if (doc.url && doc.storage_path) return { kind: 'invalid', reason: 'Both a link and a stored file are set.' }
  if (doc.url) {
    const check = checkBookUrl(doc.url)
    return check.ok ? { kind: 'url', url: check.url } : { kind: 'invalid', reason: check.reason }
  }
  if (doc.storage_path) {
    const check = checkStoragePath(doc.storage_path)
    return check.ok ? { kind: 'storage', path: check.path } : { kind: 'invalid', reason: check.reason }
  }
  return { kind: 'none' }
}

// ------------------------------------------------------------------- the page
export type PageParam = { page: number | null; notice: string | null }

// The greatest page number accepted from an address even when the document's
// length is unknown; a real edition is a few hundred pages.
const MAX_PAGE = 9999

// `?page=` from the address bar. Digits only — no sign, decimal, exponent or
// whitespace. An invalid or out-of-range value opens the book at the start and
// says so; it is never clamped to some other page, because a wrong page looks
// exactly like a right one.
export function readPageParam(raw: string | null, pageCount: number | null): PageParam {
  if (raw === null || raw === '') return { page: null, notice: null }
  if (!/^\d{1,5}$/.test(raw)) return { page: null, notice: `“${raw.slice(0, 20)}” is not a page number, so the book opens at the start.` }
  const page = Number(raw)
  if (page < 1) return { page: null, notice: 'Page numbers start at 1, so the book opens at the start.' }
  if (page > MAX_PAGE || (pageCount !== null && page > pageCount)) {
    const limit = pageCount !== null ? ` This edition has ${pageCount} pages.` : ''
    return { page: null, notice: `Page ${page} does not exist.${limit} The book opens at the start.` }
  }
  return { page, notice: null }
}

// Where the PDF viewer should land. `page` is the PRINTED page number; the
// edition's page_offset turns it into the PDF's own index. Any fragment already
// on the address is replaced, never stacked.
export function embedUrl(base: string, page: number | null, pageOffset: number): string {
  const hashless = base.split('#')[0]
  if (page === null) return hashless
  return `${hashless}#page=${Math.max(1, page + pageOffset)}`
}

// The Requirements Book address, with a validated page and an optional rule
// reference (display only, so it is length-limited and never trusted as a key).
export function bookPath(page: number | null | undefined, ref?: string | null): string {
  const params = new URLSearchParams()
  if (page !== null && page !== undefined) params.set('page', String(page))
  if (ref) params.set('ref', ref.slice(0, 60))
  const query = params.toString()
  return query ? `/book?${query}` : '/book'
}

// ------------------------------------------------- clause -> book navigation
export type ClauseBookTarget =
  | { kind: 'page'; page: number }
  // No page recorded for this clause: open the book at the start and say so.
  | { kind: 'unrecorded' }
  // A page IS recorded, but for another edition than the one this season reads.
  // It would point at the wrong place, so it is not used.
  | { kind: 'other-edition' }

export function clausePageTarget(
  clause: { source_page: number | null; regs_ref: string | null },
  seasonRegsRef: string | null,
): ClauseBookTarget {
  if (clause.source_page === null) return { kind: 'unrecorded' }
  if (clause.regs_ref === null || seasonRegsRef === null || clause.regs_ref !== seasonRegsRef) {
    return { kind: 'other-edition' }
  }
  return { kind: 'page', page: clause.source_page }
}

export function targetHref(target: ClauseBookTarget, ref?: string | null): string {
  return bookPath(target.kind === 'page' ? target.page : null, ref)
}

// Words for the link and for the line beside it.
export function targetNote(target: ClauseBookTarget): string | null {
  switch (target.kind) {
    case 'page':
      return null
    case 'unrecorded':
      return 'Page not recorded'
    case 'other-edition':
      return 'Page recorded for a different edition'
  }
}
