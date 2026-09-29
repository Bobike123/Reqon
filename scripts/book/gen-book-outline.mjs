// Writes the Requirements Book's chapter outline (sections, articles, annexes)
// into migration 20260125000500_book_outline.sql, read from the verified PDF's
// own table of contents — numbering and headings exactly as printed.
//
//   node scripts/book/gen-book-outline.mjs          rewrite the data blocks
//   node scripts/book/gen-book-outline.mjs --check  fail if they differ
//
// Needs Poppler's pdftotext. The PDF must be the pinned edition (sha256 in
// supabase/book/editions.json). For every chapter and subchapter it also records
// whether the book itself contains numbered rules there (A.1.2.3-style
// references anywhere in its text), which is what lets the Now screen tell
// "not imported" (the book has rules, the Register has none) from "the book has
// no numbered rules here" (a glossary, an annex).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATION = 'supabase/migrations/20260125000500_book_outline.sql'
const fail = (msg) => {
  console.error(`gen-book-outline: ${msg}`)
  process.exit(1)
}

const config = JSON.parse(readFileSync(join(root, 'supabase/book/editions.json'), 'utf8'))
const edition = config.editions.find((e) => e.regs_ref === 'MS2627 Rev.01') ?? fail('no MS2627 Rev.01 edition')
const pdf = join(root, edition.source)
const sha = createHash('sha256').update(readFileSync(pdf)).digest('hex')
if (sha !== edition.sha256) fail(`${edition.source} is not the pinned edition (sha256 ${sha})`)

const text = (first, last) =>
  execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', ...(first ? ['-f', String(first), '-l', String(last)] : []), pdf, '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

// ------------------------------------------------------------------ the outline
// The table of contents is on printed pages 2–5. Each entry is one line:
//   SECTION A: ADMINISTRATIVE REGULATIONS ........ 6
//      ARTICLE 1: INTRODUCTION TO MOTOSTUDENT COMPETITION ..... 7
//      ANNEX 1: CLAIMS AND IMPUGNATIONS FORM ...... 216
const ENTRY = /^\s*(SECTION ([A-Z])|ARTICLE (\d+)|ANNEX (\d+)):\s*(.*?)\s*\.{2,}\s*(\d+)\s*$/
const chapters = []
const subchapters = []
for (const line of text(2, 5).split('\n')) {
  const m = ENTRY.exec(line)
  if (!m) continue
  const [, label, code, article, annex, heading, page] = m
  if (code) {
    chapters.push({ code, label, heading, page: Number(page) })
  } else {
    const chapter = chapters.at(-1) ?? fail(`"${line.trim()}" appears before any SECTION`)
    subchapters.push({
      chapter: chapter.code,
      kind: article ? 'article' : 'annex',
      number: Number(article ?? annex),
      label,
      heading,
      page: Number(page),
    })
  }
}

// ----------------------------------------------------- where the book has rules
const ruled = new Set()
for (const m of text().matchAll(/\b([A-J])\.(\d+)\.\d+\.\d+\b/g)) ruled.add(`${m[1]}.${m[2]}`)
const chapterRuled = new Set([...ruled].map((k) => k.split('.')[0]))

// --------------------------------------------------------------- sanity checks
const codes = chapters.map((c) => c.code).join('')
if (codes !== 'ABCDEFGHIJ') fail(`expected sections A–J in order, read ${codes}`)
for (const c of chapters) {
  const mine = subchapters.filter((s) => s.chapter === c.code)
  mine.forEach((s, i) => {
    if (s.number !== i + 1) fail(`${c.code}: ${s.label} out of sequence`)
  })
}
for (const key of ruled) {
  const [code, n] = key.split('.')
  if (!subchapters.some((s) => s.chapter === code && s.kind === 'article' && s.number === Number(n))) {
    fail(`the book numbers rules under ${key}, but its table of contents has no such article`)
  }
}

const chapterRows = chapters.map((c, i) => [c.code, c.label, c.heading, c.page, i + 1, chapterRuled.has(c.code)])
const subRows = subchapters.map((s, i) => [
  s.chapter, s.kind, s.number, s.label, s.heading, s.page, i + 1,
  s.kind === 'article' && ruled.has(`${s.chapter}.${s.number}`),
])

// ---------------------------------------------------------------- write/check
const block = (rows) => {
  const body = `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]`
  if (body.includes('$json$')) fail('outline text contains the dollar-quote tag')
  const md5 = createHash('md5').update(body, 'utf8').digest('hex')
  return `maintenance.checked_json($json$${body}$json$, '${md5}')`
}

const file = join(root, MIGRATION)
let sql = readFileSync(file, 'utf8')
const original = sql
for (const [name, rows] of [['book-chapters', chapterRows], ['book-subchapters', subRows]]) {
  const open = `-- <generated:${name}>\n`
  const close = `-- </generated:${name}>`
  const start = sql.indexOf(open)
  const end = sql.indexOf(close)
  if (start < 0 || end < start) fail(`markers for ${name} not found in ${MIGRATION}`)
  sql = sql.slice(0, start + open.length) + block(rows) + '\n' + sql.slice(end)
}
const summary = `${chapterRows.length} chapters, ${subRows.length} subchapters (${subRows.filter((r) => r[1] === 'article').length} articles, ${subRows.filter((r) => r[1] === 'annex').length} annexes); numbered rules in ${chapterRuled.size} chapters / ${ruled.size} articles`
if (sql === original) {
  console.log(`ok     ${MIGRATION} — ${summary}`)
} else if (process.argv.includes('--check')) {
  console.log(`STALE  ${MIGRATION} — ${summary}`)
  process.exit(1)
} else {
  writeFileSync(file, sql)
  console.log(`wrote  ${MIGRATION} — ${summary}`)
}
