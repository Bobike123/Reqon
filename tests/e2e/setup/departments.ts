import { expect, type Page } from '@playwright/test'

// The department row (DepartmentNav): links on a wide screen, one labelled
// select on a phone. Both change ?dept= and keep every other parameter.
export async function chooseDepartment(page: Page, key: string, name: string) {
  const narrow = (page.viewportSize()?.width ?? 1280) < 640
  if (narrow) {
    await page.getByLabel('Department', { exact: true }).selectOption(key)
  } else {
    await page.getByRole('navigation', { name: 'Department navigation' }).getByRole('link', { name: new RegExp(name) }).click()
  }
  await expect(page).toHaveURL(new RegExp(`dept=${encodeURIComponent(key)}`))
}

// The proposal form sits behind "Raise a proposal".
export async function openProposalForm(page: Page) {
  const toggle = page.getByTestId('proposal-form-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  return page.locator('[data-tutorial="proposal-raise"]')
}
