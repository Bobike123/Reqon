import { describe, expect, it } from 'vitest'
import {
  bookPath,
  checkBookUrl,
  checkStoragePath,
  clausePageTarget,
  documentSource,
  embedUrl,
  readPageParam,
  targetHref,
  targetNote,
} from './source.ts'

describe('checkBookUrl', () => {
  it('accepts an https link and trims it', () => {
    expect(checkBookUrl('  https://example.org/regs.pdf ')).toEqual({ ok: true, url: 'https://example.org/regs.pdf' })
  })

  it.each([
    ['http://example.org/x.pdf', /https/],
    ['javascript:alert(1)', /https/],
    ['data:application/pdf;base64,AAAA', /https/],
    ['file:///home/u/regs.pdf', /https/],
    ['ftp://example.org/x.pdf', /https/],
    ['//example.org/x.pdf', /valid web address/],
    ['example.org/x.pdf', /valid web address/],
    ['https://user:pass@example.org/x.pdf', /user name or password/],
    ['https://example.org/a b.pdf', /spaces/],
    ['', /Enter a link/],
    ['   ', /Enter a link/],
  ])('refuses %j', (raw, reason) => {
    const result = checkBookUrl(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(reason)
  })

  it('refuses an absurdly long link', () => {
    expect(checkBookUrl(`https://example.org/${'a'.repeat(2000)}`).ok).toBe(false)
  })
})

describe('checkStoragePath', () => {
  it('accepts a relative path inside the bucket', () => {
    expect(checkStoragePath('ms2627/regulations.pdf')).toEqual({ ok: true, path: 'ms2627/regulations.pdf' })
  })

  it.each(['/etc/passwd', '../secret.pdf', 'a/../../b.pdf', 'C:/regs.pdf', 'https://x.org/a.pdf', 'a\\b.pdf', 'a\u0000b.pdf', ''])(
    'refuses %j',
    (raw) => {
      expect(checkStoragePath(raw).ok).toBe(false)
    },
  )
})

describe('documentSource', () => {
  it('is "none" when nothing is configured, or there is no row', () => {
    expect(documentSource(null)).toEqual({ kind: 'none' })
    expect(documentSource(undefined)).toEqual({ kind: 'none' })
    expect(documentSource({ url: null, storage_path: null })).toEqual({ kind: 'none' })
  })

  it('reads a link and a stored file', () => {
    expect(documentSource({ url: 'https://example.org/a.pdf', storage_path: null })).toEqual({ kind: 'url', url: 'https://example.org/a.pdf' })
    expect(documentSource({ url: null, storage_path: 'a/b.pdf' })).toEqual({ kind: 'storage', path: 'a/b.pdf' })
  })

  it('refuses to open a stored value that fails validation, even if it reached the database', () => {
    expect(documentSource({ url: 'javascript:alert(1)', storage_path: null }).kind).toBe('invalid')
    expect(documentSource({ url: null, storage_path: '../x.pdf' }).kind).toBe('invalid')
    expect(documentSource({ url: 'https://example.org/a.pdf', storage_path: 'a.pdf' }).kind).toBe('invalid')
  })
})

describe('readPageParam', () => {
  it('has no page and no notice when there is no parameter', () => {
    expect(readPageParam(null, null)).toEqual({ page: null, notice: null })
    expect(readPageParam('', 300)).toEqual({ page: null, notice: null })
  })

  it('accepts a whole page number, inside the book when its length is known', () => {
    expect(readPageParam('12', null)).toEqual({ page: 12, notice: null })
    expect(readPageParam('300', 300)).toEqual({ page: 300, notice: null })
    expect(readPageParam('1', 300)).toEqual({ page: 1, notice: null })
  })

  it.each(['0', '-3', '1.5', '1e2', '+4', ' 7', '7 ', 'abc', '12abc', '00000012', '123456', '99999'])(
    'opens the start, with a notice, for %j',
    (raw) => {
      const result = readPageParam(raw, null)
      // '00000012' has too many digits; every value here is refused.
      expect(result.page).toBeNull()
      expect(result.notice).toBeTruthy()
    },
  )

  it('refuses a page beyond a known page count, naming the length', () => {
    const result = readPageParam('301', 300)
    expect(result.page).toBeNull()
    expect(result.notice).toMatch(/300 pages/)
  })

  it('does not echo a long hostile value in full', () => {
    const result = readPageParam(`<script>${'x'.repeat(200)}`, null)
    expect(result.notice?.length).toBeLessThan(120)
  })
})

describe('embedUrl', () => {
  it('adds the PDF page fragment, shifted by the edition offset', () => {
    expect(embedUrl('https://x.org/a.pdf', 12, 0)).toBe('https://x.org/a.pdf#page=12')
    expect(embedUrl('https://x.org/a.pdf', 12, 4)).toBe('https://x.org/a.pdf#page=16')
  })

  it('never produces a page below 1, and replaces an existing fragment', () => {
    expect(embedUrl('https://x.org/a.pdf#page=3', 2, -10)).toBe('https://x.org/a.pdf#page=1')
    expect(embedUrl('https://x.org/a.pdf#page=3', null, 4)).toBe('https://x.org/a.pdf')
  })
})

describe('bookPath', () => {
  it('opens the book normally with no page', () => {
    expect(bookPath(null)).toBe('/book')
    expect(bookPath(undefined)).toBe('/book')
  })

  it('carries a page and a rule reference, encoded', () => {
    expect(bookPath(12, 'F.13.3.1')).toBe('/book?page=12&ref=F.13.3.1')
    expect(bookPath(null, 'A B&c')).toBe('/book?ref=A+B%26c')
  })
})

describe('clausePageTarget (edition isolation)', () => {
  it('uses the page when the clause belongs to the edition the season reads', () => {
    expect(clausePageTarget({ source_page: 12, regs_ref: 'ED1' }, 'ED1')).toEqual({ kind: 'page', page: 12 })
  })

  it('reports an unknown page as not recorded', () => {
    expect(clausePageTarget({ source_page: null, regs_ref: 'ED1' }, 'ED1')).toEqual({ kind: 'unrecorded' })
  })

  it('never uses a page recorded for a different edition', () => {
    expect(clausePageTarget({ source_page: 12, regs_ref: 'ED0' }, 'ED1')).toEqual({ kind: 'other-edition' })
    expect(clausePageTarget({ source_page: 12, regs_ref: null }, 'ED1')).toEqual({ kind: 'other-edition' })
    expect(clausePageTarget({ source_page: 12, regs_ref: 'ED1' }, null)).toEqual({ kind: 'other-edition' })
  })

  it('turns targets into links and notes', () => {
    expect(targetHref({ kind: 'page', page: 12 }, 'B.1')).toBe('/book?page=12&ref=B.1')
    expect(targetHref({ kind: 'unrecorded' }, 'B.1')).toBe('/book?ref=B.1')
    expect(targetHref({ kind: 'other-edition' })).toBe('/book')
    expect(targetNote({ kind: 'page', page: 1 })).toBeNull()
    expect(targetNote({ kind: 'unrecorded' })).toBe('Page not recorded')
    expect(targetNote({ kind: 'other-edition' })).toMatch(/different edition/)
  })
})
