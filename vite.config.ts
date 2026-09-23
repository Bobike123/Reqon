/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
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
