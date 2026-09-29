// Requirements Book page mapping: which printed page each Register clause
// starts on, derived from the real PDF text — never guessed.
//
// Pure functions (everything below except readPdfLines) so they can be tested
// without a PDF. scripts/book/sync-local.mjs is the only caller that touches a
// database or Storage.
//
// Page-number contract (migration 20260120, ADR-0009): clauses.source_page is
// the PRINTED page; source_page + regulation_documents.page_offset is the PDF's
// own 1-based page index, which is what the reader (book/PdfPageView.tsx) asks
// pdf.js for. This module reports both and checks they agree.

// A clause reference as printed at the start of a paragraph: "B.9.1.2".
export const CLAUSE_REF = /^([A-Z](?:\.\d{1,3}){3})(?:\s+(.*))?$/
// Any numbered heading or clause ("B.9", "B.9.2 Tires", "B.9.2.1 …"): where a
// clause's own text ends.
const ANY_REF = /^[A-Z](?:\.\d{1,3}){1,3}(?:\s|$)/
// Table-of-contents lines end in a dotted leader and a page number.
const TOC_LINE = /\.{5,}\s*\d+\s*$/
const SECTION_HEADING = /^(SECTION [A-Z]\b|ARTICLE \d+\b|ANNEX \d+\b)/

// Lower-case, accents and typography folded, punctuation dropped: the same
// sentence extracted from a PDF and imported into the database compares equal.
export function normalizeText(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const tokens = (text) => (text ? text.split(' ') : [])

// Longest common subsequence of two short token lists (≤ ~30 tokens each).
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let prev = 0
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1])
      prev = keep
    }
  }
  return row[b.length]
}

// How well the PDF text at a candidate position matches a clause's body.
//   exact  the PDF paragraph starts with the clause's first 80 characters
//   close  ≥ 85% of the body's first 20 words appear, in order, at the start
//   none   anything else (an incidental mention, a table entry, another rule)
export function scoreMatch(body, candidateText) {
  const b = normalizeText(body)
  const c = normalizeText(candidateText)
  if (!b || !c) return { kind: 'none', score: 0 }
  const head = b.slice(0, 80)
  if (c.startsWith(head)) return { kind: 'exact', score: 1 }
  const bt = tokens(b).slice(0, 20)
  const ct = tokens(c).slice(0, bt.length + 6)
  const score = lcs(bt, ct) / bt.length
  return { kind: score >= 0.85 ? 'close' : 'none', score: Math.round(score * 1000) / 1000 }
}

// The printed page number of every PDF page, read from the running footer.
// `footer` is the edition's footer pattern with one capture group for the
// number; `bottomBand` is how far up from the bottom edge (PDF points) the
// footer may sit. A page without a footer (a cover) is null.
export function readPrintedPages(pages, { footer, bottomBand = 60 }) {
  const pattern = new RegExp(footer)
  return pages.map((page) => {
    const text = page.lines
      .filter((l) => l.y <= bottomBand)
      .map((l) => l.text)
      .join(' ')
    const m = pattern.exec(text)
    return m ? Number(m[1]) : null
  })
}

// Offset such that printed + offset = PDF index, which must be the same on
// every numbered page. Returns { offset, numbered, conflicts }.
export function pageOffset(printed) {
  const offsets = new Map()
  printed.forEach((p, i) => {
    if (p === null) return
    const off = i + 1 - p
    offsets.set(off, (offsets.get(off) ?? 0) + 1)
  })
  const numbered = printed.filter((p) => p !== null).length
  if (offsets.size === 0) return { offset: null, numbered, conflicts: [] }
  const [offset] = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0]
  const conflicts = printed
    .map((p, i) => ({ pdfPage: i + 1, printed: p }))
    .filter((x) => x.printed !== null && x.pdfPage - x.printed !== offset)
  return { offset, numbered, conflicts }
}

// Every place a clause reference opens a paragraph, with the paragraph's
// text (continuing onto the next page when the paragraph does). Table-of-
// contents lines, headings and the footer band are not candidates.
export function findClauseStarts(pages, { bottomBand = 60 } = {}) {
  const body = pages.map((page) => page.lines.filter((l) => l.y > bottomBand && !TOC_LINE.test(l.text)))
  const starts = []
  body.forEach((lines, p) => {
    lines.forEach((line, i) => {
      const m = CLAUSE_REF.exec(line.text)
      if (!m) return
      const parts = [m[2] ?? '']
      let page = p
      let j = i + 1
      let taken = 0
      // Up to 12 lines of the paragraph: enough to compare its opening words.
      while (taken < 12) {
        if (j >= body[page].length) {
          page += 1
          j = 0
          if (page >= body.length || page > p + 1) break
          continue
        }
        const next = body[page][j].text
        if (ANY_REF.test(next) || SECTION_HEADING.test(next)) break
        parts.push(next)
        j += 1
        taken += 1
      }
      starts.push({ ref: m[1], pdfPage: p + 1, y: line.y, x: line.x, text: parts.join(' ').trim() })
    })
  })
  return starts
}

// Match each clause to the one paragraph that is its own start.
//
// Printed references are NOT unique (two clauses print E.5.4.5), so each
// clause is matched by its reference AND its opening words; a reference that
// opens more than one paragraph is resolved by content, and only when exactly
// one paragraph is clearly this clause's own. One entry per clause:
//   { clause_key, printed_ref, status: 'mapped' | 'unresolved' | 'ambiguous',
//     pdf_page, printed_page, match, score, context, reason }
export function mapClauses(clauses, starts, printed) {
  const byRef = new Map()
  starts.forEach((s, id) => {
    if (!byRef.has(s.ref)) byRef.set(s.ref, [])
    byRef.get(s.ref).push({ ...s, id })
  })
  const byPrinted = new Map()
  for (const c of clauses) {
    if (!byPrinted.has(c.printed_ref)) byPrinted.set(c.printed_ref, [])
    byPrinted.get(c.printed_ref).push(c)
  }

  const result = new Map()
  const miss = (c, status, reason) =>
    result.set(c.clause_key, {
      clause_key: c.clause_key,
      printed_ref: c.printed_ref,
      status,
      pdf_page: null,
      printed_page: null,
      match: null,
      score: null,
      context: null,
      reason,
    })

  for (const [ref, group] of byPrinted) {
    const candidates = byRef.get(ref) ?? []
    if (candidates.length === 0) {
      for (const c of group) miss(c, 'unresolved', 'the reference does not open any paragraph in this PDF')
      continue
    }
    // Every (clause, paragraph) pair that matches, best first.
    const pairs = []
    for (const c of group) {
      for (const s of candidates) {
        const m = scoreMatch(c.body, s.text)
        if (m.kind !== 'none') pairs.push({ c, s, ...m })
      }
    }
    pairs.sort((a, b) => b.score - a.score || a.s.pdfPage - b.s.pdfPage || b.s.y - a.s.y)
    for (const c of group) {
      const mine = pairs.filter((p) => p.c.clause_key === c.clause_key)
      if (mine.length === 0) {
        miss(c, 'unresolved', `${candidates.length} paragraph(s) start with ${ref}, but none opens with this clause's text`)
        continue
      }
      const best = mine[0]
      // Another paragraph matching this clause as well, or this paragraph
      // matching another clause of the same reference as well: ambiguous.
      const rival = mine.find((p) => p.s.id !== best.s.id && p.score >= best.score - 0.05)
      const contender = pairs.find(
        (p) => p.s.id === best.s.id && p.c.clause_key !== c.clause_key && p.score >= best.score - 0.05,
      )
      if (rival || contender) {
        miss(
          c,
          'ambiguous',
          rival
            ? `paragraphs on PDF pages ${best.s.pdfPage} and ${rival.s.pdfPage} both match`
            : `the paragraph on PDF page ${best.s.pdfPage} matches ${contender.c.clause_key} as well`,
        )
        continue
      }
      const printedPage = printed[best.s.pdfPage - 1] ?? null
      if (printedPage === null) {
        miss(c, 'unresolved', `PDF page ${best.s.pdfPage} carries no printed page number`)
        continue
      }
      result.set(c.clause_key, {
        clause_key: c.clause_key,
        printed_ref: c.printed_ref,
        status: 'mapped',
        pdf_page: best.s.pdfPage,
        printed_page: printedPage,
        match: best.kind,
        score: best.score,
        context: `${ref} ${best.s.text}`.slice(0, 120),
        reason: null,
      })
    }
  }
  return clauses.map((c) => result.get(c.clause_key))
}

// Text lines of every page, top to bottom, through pdf.js. `getDocument` is
// passed in (pdfjs-dist/legacy/build/pdf.mjs in Node) so this module imports
// nothing and stays testable.
export async function readPdfLines(data, getDocument) {
  const task = getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  try {
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const rows = new Map()
      for (const item of content.items) {
        if (!('str' in item) || item.str === '') continue
        const y = Math.round(item.transform[5])
        if (!rows.has(y)) rows.set(y, [])
        rows.get(y).push({ x: item.transform[4], s: item.str, w: item.width })
      }
      // Items whose baselines differ by a point or two are one line (a clause
      // reference is sometimes set a point lower than its first words).
      const merged = []
      for (const [y, items] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
        const last = merged[merged.length - 1]
        if (last && last[0] - y <= 2) last[1].push(...items)
        else merged.push([y, [...items]])
      }
      const lines = merged
        .map(([y, items]) => {
          items.sort((a, b) => a.x - b.x)
          let text = ''
          let end = null
          for (const it of items) {
            if (end !== null && it.x - end > 1.5 && !text.endsWith(' ') && !it.s.startsWith(' ')) text += ' '
            text += it.s
            end = it.x + it.w
          }
          return { x: Math.round(items[0].x), y, text: text.replace(/\s+/g, ' ').trim() }
        })
        .filter((l) => l.text)
      pages.push({ index: i, lines })
      page.cleanup()
    }
    return pages
  } finally {
    await task.destroy()
  }
}
