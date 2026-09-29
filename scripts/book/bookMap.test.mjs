// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findClauseStarts, mapClauses, normalizeText, pageOffset, readPdfLines, readPrintedPages, scoreMatch } from './bookMap.mjs'

// A page as readPdfLines returns it: lines top (high y) to bottom.
const page = (index, lines, printed = index) => ({
  index,
  lines: [...lines.map((text, i) => ({ x: 91, y: 760 - i * 16, text })), { x: 89, y: 38, text: `Rev. 01 – 04/2026 ${printed}` }],
})
const FOOTER = 'Rev\\. 01 – 04/2026\\s+(\\d+)'
const clause = (clause_key, body, printed_ref = clause_key) => ({ clause_key, printed_ref, body })

describe('normalizeText and scoreMatch', () => {
  it('folds typography, so PDF text and imported text compare equal', () => {
    expect(normalizeText('“Rims” – made of ﬁbre…')).toBe('rims made of fibre')
    expect(scoreMatch('Rims made of composite materials are not permitted.', 'Rims made of composite materials are not permitted. More.').kind).toBe('exact')
  })

  it('accepts a superscript split ("1st" extracted as "1 … st") but not an unrelated paragraph', () => {
    const close = scoreMatch(
      'The maximum score for the 1st milestone is 75 points and more words follow here.',
      'The maximum score for the 1 milestone is 75 points and more words follow here.',
    )
    expect(close.kind).toBe('close')
    expect(scoreMatch('The maximum score for the 1st milestone is 75 points.', 'Helmets must be approved by the Organization.').kind).toBe('none')
  })
})

describe('printed pages and offset', () => {
  it('reads the footer number and finds one offset (a cover without a number is null)', () => {
    const pages = [{ index: 1, lines: [] }, page(2, ['x'], 2), page(3, ['y'], 3)]
    const printed = readPrintedPages(pages, { footer: FOOTER })
    expect(printed).toEqual([null, 2, 3])
    expect(pageOffset(printed)).toEqual({ offset: 0, numbered: 2, conflicts: [] })
  })

  it('reports pages whose numbering breaks the offset', () => {
    expect(pageOffset([null, 1, 2, 9]).conflicts).toEqual([{ pdfPage: 4, printed: 9 }])
    expect(pageOffset([null, null]).offset).toBeNull()
  })
})

describe('mapClauses', () => {
  const pages = [
    // Table of contents: a reference with a dotted leader is not a start.
    page(1, ['B.9.1.2 Rims .......................................... 2']),
    page(2, [
      'B.9.1.1 Wheels must be made of approved alloys and inspected before the event.',
      'B.9.1.2 Rims made of composite materials (e.g. carbon fibre) are not permitted.',
      'Rims must be manufactured from steel or aluminium.',
      // An incidental cross-reference in running text: not a start.
      'B.9.1.3 Crash protectors described in Article B.9.1.2 must be rounded.',
    ]),
    page(3, [
      'E.5.4.5 If the IMD does not trigger the shutdown within the specified time, the prototype fails.',
      'E.5.4.6 Another rule entirely about spraying the prototype with water for a while.',
      'E.5.4.5 The test will be considered successful if the IMD does not trigger during spraying.',
    ]),
  ]
  const printed = readPrintedPages(pages, { footer: FOOTER })
  const starts = findClauseStarts(pages)

  it('never takes a table-of-contents line or a cross-reference as a start', () => {
    expect(starts.map((s) => `${s.ref}@${s.pdfPage}`)).toEqual(['B.9.1.1@2', 'B.9.1.2@2', 'B.9.1.3@2', 'E.5.4.5@3', 'E.5.4.6@3', 'E.5.4.5@3'])
    // The paragraph ends where the next numbered rule begins.
    expect(starts[1].text).toBe('Rims made of composite materials (e.g. carbon fibre) are not permitted. Rims must be manufactured from steel or aluminium.')
  })

  it('maps each clause to its own paragraph, telling two rules that print the same reference apart by content', () => {
    const result = mapClauses(
      [
        clause('B.9.1.2', 'Rims made of composite materials (e.g. carbon fibre) are not permitted.'),
        clause('E.5.4.5', 'If the IMD does not trigger the shutdown within the specified time, the prototype fails.'),
        clause('E.5.4.5#2', 'The test will be considered successful if the IMD does not trigger during spraying.', 'E.5.4.5'),
      ],
      starts,
      printed,
    )
    expect(result.map((r) => [r.clause_key, r.status, r.printed_page, r.match])).toEqual([
      ['B.9.1.2', 'mapped', 2, 'exact'],
      ['E.5.4.5', 'mapped', 3, 'exact'],
      ['E.5.4.5#2', 'mapped', 3, 'exact'],
    ])
  })

  it('leaves a clause unresolved when its reference opens no paragraph, or none with its text', () => {
    const result = mapClauses(
      [clause('Z.1.1.1', 'Nothing like this exists.'), clause('B.9.1.1', 'A completely different sentence about fuel tanks and their venting.')],
      starts,
      printed,
    )
    expect(result.map((r) => [r.status, r.printed_page])).toEqual([
      ['unresolved', null],
      ['unresolved', null],
    ])
    expect(result[1].reason).toMatch(/none opens with this clause's text/)
  })

  it('refuses to choose between two paragraphs that match equally', () => {
    const twice = [page(1, ['A.1.1.1 The same words twice.', 'A.1.1.2 x']), page(2, ['A.1.1.1 The same words twice.'])]
    const result = mapClauses([clause('A.1.1.1', 'The same words twice.')], findClauseStarts(twice), readPrintedPages(twice, { footer: FOOTER }))
    expect(result[0].status).toBe('ambiguous')
    expect(result[0].printed_page).toBeNull()
  })
})

// The real edition, when the file is present: early, middle, late and
// duplicate-reference clauses land on the page the PDF prints them on.
const PDF = 'static/book/MS2627_MotoStudent.pdf'
describe.runIf(existsSync(PDF))('the MS2627 Rev.01 PDF', () => {
  it('maps representative clauses to their printed pages, with offset 0 over 234 pages', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pages = await readPdfLines(new Uint8Array(readFileSync(PDF)), getDocument)
    expect(pages).toHaveLength(234)
    const printed = readPrintedPages(pages, { footer: FOOTER })
    expect(pageOffset(printed)).toEqual({ offset: 0, numbered: 233, conflicts: [] })
    const fixtures = [
      ['A.1.1.1', 'A.1.1.1', 'MotoStudent is an international academic challenge aimed at student teams from higher education institutions. For the purposes of ', 7],
      ['A.6.4.2', 'A.6.4.2', 'The MS1 2nd milestone, Product Definition, requires the teams to describe to the jury the different technical solutions selected f', 29],
      ['B.9.1.2', 'B.9.1.2', 'Rims made of composite materials (e.g. carbon fibre, glass fibre reinforced composites or similar) are not permitted. Rims must be', 51],
      ['C.6.1.5', 'C.6.1.5', 'The use of a lambda (oxygen) sensor is compulsory. The lambda value must be recorded at any time the engine is running. The data a', 78],
      ['E.5.4.5', 'E.5.4.5', 'If the IMD does not trigger the shutdown of the High Voltage System within the specified time, the prototype will be considered no', 121],
      ['E.5.4.5#2', 'E.5.4.5', 'The test will be considered successful if the IMD does not trigger during the 60 seconds of spraying and during the following 60 s', 122],
      ['F.5.2.3', 'F.5.2.3', 'The objective of this section is to allow the jury to quickly understand the problem addressed, the proposed innovative solution, ', 140],
      ['F.5.2.3#2', 'F.5.2.3', 'The Executive Abstract must summarize the key aspects of the milestone, including:\n- The problem or limitation identified by the t', 140],
      ['H.6.3.4', 'H.6.3.4', 'Follow the instructions of the Organization at all times. This is a critical safety situation; any confrontation, obstruction or l', 213],
    ]
    const result = mapClauses(
      fixtures.map(([key, ref, body]) => clause(key, body, ref)),
      findClauseStarts(pages),
      printed,
    )
    expect(result.map((r) => [r.clause_key, r.status, r.printed_page, r.pdf_page])).toEqual(fixtures.map(([key, , , p]) => [key, 'mapped', p, p]))
  }, 60_000)
})
