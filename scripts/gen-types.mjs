#!/usr/bin/env node
// Regenerates src/lib/database.types.ts from the live schema without ever
// leaving a broken or empty file in place: the CLI's output is captured to a
// temp file, validated, then atomically renamed over the target. A failed or
// malformed generation exits non-zero and leaves the existing file untouched.
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(REPO, 'src/lib/database.types.ts')

const projectId = process.env.SUPABASE_PROJECT_ID
if (!projectId) {
  console.error('SUPABASE_PROJECT_ID is not set. Refusing to run — the previous types file is untouched.')
  process.exit(1)
}

// Staged NEXT TO the target, not in os.tmpdir(): /tmp is often a separate
// filesystem (tmpfs), where rename() fails with EXDEV and the only fallback is
// writing straight into the target — which an interrupted write can truncate.
// Same directory means the final rename is always same-filesystem and atomic.
const tmpFile = join(dirname(TARGET), `.database.types.${process.pid}.tmp`)

try {
  // supabase is a pinned devDependency (see package.json); npx resolves it
  // from node_modules/.bin rather than requiring a global install.
  const output = execFileSync(
    'npx',
    ['--no-install', 'supabase', 'gen', 'types', 'typescript', '--project-id', projectId, '--schema', 'public'],
    { encoding: 'utf8', cwd: REPO },
  )

  // Thrown, not process.exit(): exit() would skip the `finally` below and
  // leave the staged temp file behind in src/lib.
  if (output.trim().length === 0) throw new Error('generator produced empty output')
  if (!output.includes('export type Database')) {
    throw new Error('generator output does not contain "export type Database"')
  }

  writeFileSync(tmpFile, output)
  // Re-read what was written and re-check, in case of a partial/encoding-mangled write.
  const written = readFileSync(tmpFile, 'utf8')
  if (written.trim().length === 0 || !written.includes('export type Database')) {
    throw new Error('the staged file failed validation after writing')
  }

  renameSync(tmpFile, TARGET) // atomic: same directory, same filesystem
  console.log(`wrote ${TARGET}`)
} catch (err) {
  console.error(`types:gen failed: ${err.message ?? err}. The previous types file is untouched.`)
  process.exitCode = 1
} finally {
  rmSync(tmpFile, { force: true })
}
