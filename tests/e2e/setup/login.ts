import { expect, type Page } from '@playwright/test'

export async function login(page: Page, email: string, password: string) {
  await page.goto('/')
  // A prior actor's session may still be active on this page (specs switch
  // between fixture users on purpose, e.g. member -> Head -> a different
  // Head) — sign out first so the real Login form is what we're filling.
  // At narrow viewports AppHeader.tsx collapses "Sign out" behind the "Menu"
  // toggle (the desktop copy is `hidden sm:flex`, the phone-menu copy only
  // exists in the DOM once opened) — open it first so the desktop-only
  // button being present-but-hidden doesn't make `.first()` silently match
  // an invisible element and skip sign-out entirely.
  const menuButton = page.getByRole('button', { name: 'Menu' })
  // isVisible() does not wait: right after goto('/') the app may still be restoring the session, so
  // neither the Login form nor the header exists yet and the sign-out below would be skipped while a
  // previous user is still signed in (seen once at 375 px in Phase 6). Wait until one of them shows.
  await expect(
    page.getByLabel('Email').or(menuButton).or(page.getByRole('button', { name: 'Sign out' })).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 15_000 })
  if (await menuButton.isVisible().catch(() => false)) {
    await menuButton.click()
  }
  const signOut = page.getByRole('button', { name: 'Sign out' }).first()
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click()
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 10_000 })
  }
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Wait for the Login form itself (its Email field) to disappear, not for
  // the button's accessible name to stop matching — while signing in the
  // button reads "Signing in…", which no longer contains "Sign in" and would
  // make a name-based wait resolve before authentication actually finishes.
  await expect(page.getByLabel('Email')).toHaveCount(0, { timeout: 15_000 })
}
