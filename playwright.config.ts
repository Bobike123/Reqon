import { defineConfig, devices } from '@playwright/test'

// Real-browser integration verification (Phase 13). Runs against the local
// Supabase stack (`npx supabase start`, migrations already applied) and the
// Vite dev server — never against the hosted project. `.env.development.local`
// already points `npm run dev` at http://127.0.0.1:54321.
//
// Fixtures (test users, a temporary Head assignment on two real departments,
// one synthetic spec) are created in globalSetup and removed in
// globalTeardown, using the service_role key read live from
// `npx supabase status -o env` — never hardcoded, and never usable from the
// browser context the tests drive.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // fixtures are shared, real database rows — no isolated parallel workers
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalSetup: './tests/e2e/setup/global-setup.ts',
  globalTeardown: './tests/e2e/setup/global-teardown.ts',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-narrow', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    // Bound to 127.0.0.1 explicitly: on CI runners `localhost` can resolve to ::1, so Vite would listen on IPv6
    // only while Playwright polls 127.0.0.1 and times out (every CI run since 2026-09-29). Its output is piped
    // so a failure to start shows the predev / Vite log instead of a bare timeout.
    command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    stdout: 'pipe',
    stderr: 'pipe',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
