/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The attachment compression worker (src/attachments/media) loads Mediabunny with a dynamic import,
  // which needs an ES-module worker; every browser that can compress video supports those.
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Playwright owns tests/e2e (real browser, real local DB, its own
    // runner and config) — Vitest must never try to collect those files.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Browser-only media encoders (WebCodecs via Mediabunny, OffscreenCanvas, <video> frame grabs) cannot
      // run in jsdom. Their decisions are tested through prepare.test.ts with a scripted worker; the
      // encoders themselves are exercised by tests/e2e/attachments-flow.spec.ts and the manual phone check
      // (docs/ultraplan Phase 3).
      exclude: [
        'src/attachments/media/video.ts',
        'src/attachments/media/image.ts',
        'src/attachments/media/posterFallback.ts',
        'src/attachments/media/compress.worker.ts',
      ],
      // Floor set at the measured baseline, rounded down — a regression guard,
      // not an aspirational target. Raise it as real coverage improves; don't
      // lower it to make a red run green.
      //   2026-09-22 (Phase 1, 371 tests):  81 / 70 / 81 / 83
      //   2026-09-23 (Phase 8, 484 tests):  89.08 / 79.98 / 89.15 / 92.26
      thresholds: {
        statements: 89,
        branches: 79,
        functions: 89,
        lines: 92,
      },
    },
  },
})
