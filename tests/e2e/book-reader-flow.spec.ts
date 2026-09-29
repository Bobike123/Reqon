import { test, expect, type Locator, type Page } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// The Requirements Book against the REAL season document: the MS2627 Rev.01
// PDF imported into the local private `regulations` bucket and its clause
// pages recorded by `npm run book:sync:local` (which `npm run dev`, the web
// server below, runs first). Every page check reads what pdf.js actually DREW
// (data-rendered-page is set only when that page has finished rendering) and
// that the canvas has ink — never just the address or a label.
//
// The pages expected here are the PRINTED pages the PDF itself carries for
// those clauses (supabase/book/ms2627-rev-01.pages.json; this edition's page
// offset is 0, so printed page = PDF page).
const drawn = (scope: Page | Locator) => scope.getByTestId('book-canvas-box')
const isNarrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024

async function canvasSignature(page: Page) {
  // A small fingerprint of the drawn pixels: proves something was drawn, and
  // changes when a different page is drawn.
  return page
    .getByTestId('book-canvas-box')
    .locator('canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d')
      if (!ctx || canvas.width === 0) return { ink: 0, hash: '' }
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let ink = 0
      let hash = 0
      for (let i = 0; i < data.length; i += 16) {
        if (data[i] < 200) ink++
        hash = (hash * 31 + data[i]) | 0
      }
      return { ink, hash: String(hash) }
    })
}

// Open a rule's page from its row. On a phone the reader covers the list, so
// it is closed first to reach the next row.
async function openRule(page: Page, clauseKey: string, search: string) {
  if (isNarrow(page) && (await page.getByTestId('register-reader').count()) > 0) {
    await page.getByTestId('register-reader-close').click()
  }
  await page.getByLabel('Search').fill(search)
  await page.getByTestId(`book-link-${clauseKey}`).click()
  return page.getByTestId('register-reader')
}

test.describe('Book reader (R22-R23)', () => {
  test('the real document opens, draws the requested page, and validates page bounds', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)

    await page.goto('/book')
    await expect(page.getByTestId('book-location')).toContainText('The start of the book')
    await expect(drawn(page)).toHaveAttribute('data-rendered-page', '1', { timeout: 20_000 })
    await expect(page.getByTestId('book-open-external')).toBeVisible()
    await expect(page.getByText('of 234')).toBeVisible()

    await page.goto('/book?page=50')
    await expect(drawn(page)).toHaveAttribute('data-rendered-page', '50', { timeout: 20_000 })
    expect((await canvasSignature(page)).ink).toBeGreaterThan(100)
    // Next turns the page in the same reader and keeps it in the address.
    await page.getByRole('button', { name: /Next/ }).click()
    await expect(drawn(page)).toHaveAttribute('data-rendered-page', '51', { timeout: 20_000 })
    await expect(page).toHaveURL(/page=51/)
    await page.reload()
    await expect(drawn(page)).toHaveAttribute('data-rendered-page', '51', { timeout: 20_000 })

    await page.goto('/book?page=9999')
    await expect(page.getByTestId('book-page-notice')).toContainText('Page 9999 does not exist. This edition has 234 pages.')
    await expect(drawn(page)).toHaveAttribute('data-rendered-page', '1', { timeout: 20_000 })
  })

  test('Register rules open on their own pages, and another rule moves the open reader', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)

    // Middle of the book.
    await page.goto('/register?search=B.9.1.2')
    await page.getByTestId('book-link-B.9.1.2').click()
    const reader = page.getByTestId('register-reader')
    await expect(reader).toBeVisible()
    await expect(drawn(reader)).toHaveAttribute('data-rendered-page', '51', { timeout: 20_000 })
    await expect(page).toHaveURL(/rule=B\.9\.1\.2/)
    await expect(page).toHaveURL(/search=B\.9\.1\.2/)
    const middle = await canvasSignature(page)
    expect(middle.ink).toBeGreaterThan(100)

    // Two rules that print the same reference (E.5.4.5) are told apart by
    // clause_key and open on their own pages.
    await expect(drawn(await openRule(page, 'E.5.4.5', 'E.5.4.5'))).toHaveAttribute('data-rendered-page', '121', { timeout: 20_000 })
    await expect(drawn(await openRule(page, 'E.5.4.5#2', 'E.5.4.5'))).toHaveAttribute('data-rendered-page', '122', { timeout: 20_000 })
    expect((await canvasSignature(page)).hash).not.toBe(middle.hash)

    // Early and late pages.
    await expect(drawn(await openRule(page, 'A.1.1.1', 'A.1.1.1'))).toHaveAttribute('data-rendered-page', '7', { timeout: 20_000 })
    await expect(drawn(await openRule(page, 'H.6.3.4', 'H.6.3.4'))).toHaveAttribute('data-rendered-page', '213', { timeout: 20_000 })

    // A refresh keeps the search, the rule and the page.
    await page.reload()
    await expect(page.getByLabel('Search')).toHaveValue('H.6.3.4')
    await expect(drawn(page.getByTestId('register-reader'))).toHaveAttribute('data-rendered-page', '213', { timeout: 20_000 })

    // Closing returns to the list with the search intact and focus on the rule.
    await page.getByTestId('register-reader-close').click()
    await expect(page.getByTestId('register-reader')).toHaveCount(0)
    await expect(page.getByLabel('Search')).toHaveValue('H.6.3.4')
    await expect(page.getByTestId('book-link-H.6.3.4')).toBeFocused()
  })

  test('the private file is refused to anyone not signed in', async ({ request }) => {
    const path = runSql(`select storage_path from regulation_documents where regs_ref = 'MS2627 Rev.01'`).trim()
    expect(path).toMatch(/^editions\/ms2627-rev-01\/[0-9a-f]{16}\.pdf$/)
    const res = await request.get(`http://127.0.0.1:54321/storage/v1/object/public/regulations/${path}`)
    expect(res.ok()).toBe(false)
  })

  test('an unreachable file shows a plain error and "Try again", never a blank or crashed page', async ({ page }) => {
    const m = readManifest()
    // Break the real row's pointer for the length of this one test only, and
    // put back exactly what was there.
    const original = runSql(`select storage_path from regulation_documents where regs_ref = 'MS2627 Rev.01'`).trim()
    runSql(`update regulation_documents set storage_path = 'book/does-not-exist.pdf' where regs_ref = 'MS2627 Rev.01'`)
    try {
      await login(page, m.users.member.email, m.password)
      await page.goto('/book')
      await expect(page.getByRole('heading', { name: 'The Requirements Book could not be opened' })).toBeVisible()
      await expect(page.getByRole('alert')).toContainText('Object not found')
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    } finally {
      runSql(`update regulation_documents set storage_path = '${original.replace(/'/g, "''")}' where regs_ref = 'MS2627 Rev.01'`)
    }
  })
})
