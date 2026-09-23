#!/usr/bin/env node
// Phase 7 §7.6: a regression guard against accidentally undoing route
// splitting (App.tsx's lazy() imports) — not a target for the smallest
// possible bundle. If the largest JS chunk grows back toward the pre-split
// monolith (635 kB, measured 2026-09-23 by temporarily reverting App.tsx to
// static imports and rebuilding), something likely pulled a route screen
// back into eager code, or a big new eager dependency landed in the shell.
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const distAssets = path.join(process.cwd(), 'dist', 'assets')
// Comfortably above the measured 483 kB post-split entry chunk (room for
// real shell growth) but well under the 635 kB single-bundle baseline this
// phase split apart, so a genuine regression back to one bundle still trips it.
const LARGEST_CHUNK_BUDGET_BYTES = 550_000

const files = readdirSync(distAssets).filter((f) => f.endsWith('.js'))
if (files.length === 0) {
  console.error('No JS chunks found in dist/assets — did vite build run first?')
  process.exit(1)
}

const sizes = files
  .map((file) => ({ file, bytes: statSync(path.join(distAssets, file)).size }))
  .sort((a, b) => b.bytes - a.bytes)
const largest = sizes[0]

console.log(`Largest JS chunk: ${largest.file} — ${(largest.bytes / 1000).toFixed(1)} kB`)

if (largest.bytes > LARGEST_CHUNK_BUDGET_BYTES) {
  console.error(
    `Largest chunk (${largest.file}, ${(largest.bytes / 1000).toFixed(1)} kB) exceeds the ` +
      `${(LARGEST_CHUNK_BUDGET_BYTES / 1000).toFixed(0)} kB budget. If a route screen moved back ` +
      `into eager code, check src/App.tsx's lazy() imports.`,
  )
  process.exit(1)
}
