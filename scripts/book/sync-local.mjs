#!/usr/bin/env node
// npm run book:sync:local — put the season's Requirements Book into the LOCAL
// Supabase stack: upload the PDF to the private `regulations` bucket, point the
// edition's existing regulation_documents row at it, and record each clause's
// verified printed page (clauses.source_page), derived from the PDF text.
//
//   npm run book:sync:local                 apply (idempotent; a rerun is a no-op)
//   npm run book:sync:local -- --dry-run    show what would change; writes nothing
//   npm run book:sync:local -- --workdir /path/to/other/project   another local stack
//   npm run book:sync:local -- --rederive   re-read the PDF even if the manifest matches
//
// Local only, by construction. Targets come from `supabase status` of this
// checkout's own local stack, never from the environment; both the API and the
// database must be on this machine, and the Storage API must be serving the
// very database the psql connection reaches. The service-role key is read from
// that status output into this process only — never printed, never written,
// never a VITE_ variable. Signed URLs are never created or stored.
//
// What it may change, and nothing else:
//   * Storage: adds ONE object, editions/<edition>/<sha256 prefix>.pdf. Never
//     overwrites or deletes an object.
//   * regulation_documents (the edition's existing row, never a new one):
//     storage_path, page_count, page_offset — only when the row has no source
//     yet, or its source is verifiably the same file.
//   * clauses.source_page: only where it is NULL and the page is verified.
//     A recorded page that disagrees is reported as a conflict, not replaced.
// Clause ids, bodies, editions, statuses and task/proposal links are never touched.
import { createHash } from 'node:crypto'
import { execFile as execFileCb } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { findClauseStarts, mapClauses, pageOffset, readPdfLines, readPrintedPages } from './bookMap.mjs'

const execFile = promisify(execFileCb)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// Bump when bookMap.mjs changes how pages are derived: old manifests are then re-derived.
const GENERATOR = 'bookMap v1'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

class SetupError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, workdir: REPO, edition: null, simulateFailure: null, rederive: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--workdir') args.workdir = path.resolve(argv[++i] ?? '')
    else if (a === '--edition') args.edition = argv[++i] ?? null
    // Read the PDF again even when the manifest already covers this file and
    // these clauses.
    else if (a === '--rederive') args.rederive = true
    // Verification aid: stop after the upload, before the database write, to
    // prove an interrupted run leaves the old source in place and retries cleanly.
    else if (a === '--simulate-failure-after-upload') args.simulateFailure = 'after-upload'
    else if (a === '--help' || a === '-h') args.help = true
    else throw new SetupError(`Unknown option ${a}. Try --help.`)
  }
  return args
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const lit = (value) => (value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`)
const int = (value) => {
  if (!Number.isInteger(value)) throw new SetupError(`internal: ${value} is not an integer`)
  return String(value)
}

// ------------------------------------------------------------ local target
async function localTarget(workdir) {
  const configPath = path.join(workdir, 'supabase', 'config.toml')
  if (!existsSync(configPath)) throw new SetupError(`No supabase/config.toml under ${workdir}.`)
  const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(configPath, 'utf8'))?.[1]
  if (!projectId) throw new SetupError(`No project_id in ${configPath}.`)

  let status
  try {
    const { stdout } = await execFile('npx', ['--no-install', 'supabase', 'status', '-o', 'json', '--workdir', workdir], {
      cwd: REPO,
      maxBuffer: 1 << 20,
    })
    status = JSON.parse(stdout.slice(stdout.indexOf('{')))
  } catch {
    throw new SetupError(
      `The local Supabase stack for "${projectId}" is not running (or the Supabase CLI is missing).\n` +
        '  Start it with:  npx supabase start      then run this again (npm run local:setup does both).',
    )
  }
  const api = new URL(status.API_URL ?? 'invalid:')
  const db = new URL(status.DB_URL ?? 'invalid:')
  if (!LOCAL_HOSTS.has(api.hostname) || !LOCAL_HOSTS.has(db.hostname)) {
    throw new SetupError(`Refusing: the Supabase status points at ${api.hostname} / ${db.hostname}, not this machine.`)
  }
  if (!status.SERVICE_ROLE_KEY) throw new SetupError('The local stack reported no service-role key.')

  // The database container of THIS project, publishing the port the status names.
  const container = `supabase_db_${projectId}`
  let published
  try {
    const { stdout } = await execFile('docker', ['port', container, '5432/tcp'])
    published = stdout
  } catch {
    throw new SetupError(`Docker container ${container} is not running. Start the stack with: npx supabase start`)
  }
  if (!published.split('\n').some((line) => line.trim().endsWith(`:${db.port}`))) {
    throw new SetupError(`Refusing: ${container} does not publish port ${db.port} named by the status (ambiguous target).`)
  }
  return { projectId, container, apiUrl: api.origin, serviceKey: status.SERVICE_ROLE_KEY }
}

async function psql(target, sql) {
  try {
    const child = execFile('docker', ['exec', '-i', target.container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      maxBuffer: 64 << 20,
    })
    child.child.stdin.end(sql)
    const { stdout } = await child
    return stdout
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split('\n').slice(0, 4).join('\n  ')
    throw new SetupError(`The local database refused the change:\n  ${detail}`)
  }
}

async function psqlJson(target, query) {
  const out = (await psql(target, `select coalesce((${query}), 'null'::json);`)).trim()
  return JSON.parse(out.split('\n').pop())
}

// ------------------------------------------------------------ Storage API
function storage(target, bucket) {
  const headers = { Authorization: `Bearer ${target.serviceKey}`, apikey: target.serviceKey }
  const objectUrl = (key) => `${target.apiUrl}/storage/v1/object/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
  return {
    async bucket() {
      const res = await fetch(`${target.apiUrl}/storage/v1/bucket/${bucket}`, { headers })
      if (!res.ok) throw new SetupError(`The local Storage API has no "${bucket}" bucket (HTTP ${res.status}). Are the migrations applied?`)
      return res.json()
    },
    // The object's bytes, or null when there is no such object.
    async download(key) {
      const res = await fetch(objectUrl(key), { headers })
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      const text = await res.text()
      if (res.status === 404 || /not.?found/i.test(text)) return null
      throw new SetupError(`Could not read ${bucket}/${key} from local Storage (HTTP ${res.status}).`)
    },
    // 'uploaded', or 'exists' when an object is already at that key.
    async upload(key, bytes) {
      const res = await fetch(objectUrl(key), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/pdf', 'x-upsert': 'false', 'Cache-Control': 'max-age=3600' },
        body: bytes,
      })
      if (res.ok) return 'uploaded'
      const text = await res.text()
      if (res.status === 409 || /already exists|duplicate/i.test(text)) return 'exists'
      throw new SetupError(`Local Storage refused the upload of ${bucket}/${key} (HTTP ${res.status}).`)
    },
  }
}

// ------------------------------------------------------------ the run
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).join('\n'))
    return 0
  }
  const config = JSON.parse(readFileSync(path.join(REPO, 'supabase/book/editions.json'), 'utf8'))
  const target = await localTarget(args.workdir)
  const store = storage(target, config.bucket)

  // The Storage API must be serving this very database: its bucket is the row
  // the psql connection sees, created at the same instant.
  const apiBucket = await store.bucket()
  const dbBucket = await psqlJson(target, `select row_to_json(b) from (select id, public, created_at from storage.buckets where id = ${lit(config.bucket)}) b`)
  if (!dbBucket || Date.parse(dbBucket.created_at) !== Date.parse(apiBucket.created_at)) {
    throw new SetupError('Refusing: the Storage API and the database connection do not belong to the same local stack.')
  }
  if (dbBucket.public) throw new SetupError(`Refusing: the "${config.bucket}" bucket is public; it must stay private.`)

  // Which edition: the current season's, unless named.
  const season = await psqlJson(target, `select row_to_json(s) from (select label, regs_ref from seasons where is_current) s`)
  const regsRef = args.edition ?? season?.regs_ref
  if (!regsRef) throw new SetupError('No current season, so no edition to set up. Pass --edition "<regs_ref>".')
  // Edition identifiers are short names ("MS2627 Rev.01"); anything else is
  // refused before it gets near a SQL statement.
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(regsRef)) throw new SetupError(`Refusing an edition identifier with unexpected characters: ${JSON.stringify(regsRef)}`)
  const edition = config.editions.find((e) => e.regs_ref === regsRef)
  if (!edition) {
    throw new SetupError(`No local source is described for edition "${regsRef}" (supabase/book/editions.json). Nothing was changed.`, 2)
  }

  // The file: exactly the one described, by content.
  const sourcePath = path.join(REPO, edition.source)
  if (!existsSync(sourcePath)) throw new SetupError(`Missing source PDF: ${edition.source}. Nothing was changed.`)
  const bytes = readFileSync(sourcePath)
  const fingerprint = sha256(bytes)
  if (fingerprint !== edition.sha256) {
    throw new SetupError(
      `Refusing: ${edition.source} is not the file described for ${regsRef}\n` +
        `  expected sha256 ${edition.sha256}\n  found    sha256 ${fingerprint}\n` +
        '  Check the edition, then update supabase/book/editions.json deliberately.',
      2,
    )
  }
  // The edition's existing row and clauses.
  const doc = await psqlJson(
    target,
    `select row_to_json(d) from (select regs_ref, url, storage_path, page_offset, page_count from regulation_documents where regs_ref = ${lit(regsRef)}) d`,
  )
  if (!doc) throw new SetupError(`Edition "${regsRef}" has no regulation_documents row. Apply the migrations first (npm run local:setup).`)
  const clauses =
    (await psqlJson(
      target,
      `select json_agg(json_build_object('clause_key', clause_key, 'printed_ref', printed_ref, 'body', body, 'source_page', source_page) order by clause_key) from clauses where regs_ref = ${lit(regsRef)}`,
    )) ?? []
  if (clauses.length === 0) throw new SetupError(`Edition "${regsRef}" has no clauses in this database.`)

  // Page mapping, and proof that this PDF is this edition's text. The manifest
  // from an earlier run is reused only when it was derived from this very file
  // and these very clauses (both fingerprinted); otherwise the PDF is read.
  const manifestPath = path.join(REPO, 'supabase/book', `${slug(regsRef)}.pages.json`)
  const clausesDigest = sha256(JSON.stringify(clauses.map((c) => [c.clause_key, c.printed_ref, c.body])))
  const saved = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  const reusable =
    !args.rederive && saved?.generator === GENERATOR && saved.sha256 === fingerprint && saved.clauses_digest === clausesDigest
  let entries
  let pageCount
  let offset
  if (reusable) {
    entries = [
      ...saved.entries.map((e) => ({ ...e, status: 'mapped' })),
      ...saved.unresolved.map((u) => ({ ...u, pdf_page: null, printed_page: null, match: null })),
    ]
    pageCount = saved.page_count
    offset = { offset: saved.page_offset }
  } else {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pages = await readPdfLines(new Uint8Array(bytes), getDocument)
    if (pages.length !== edition.page_count) {
      throw new SetupError(`Refusing: the PDF has ${pages.length} pages; ${edition.page_count} are described.`, 2)
    }
    const opening = pages.slice(0, 4).flatMap((p) => p.lines.map((l) => l.text)).join(' ')
    const missing = edition.identity.filter((text) => !opening.includes(text))
    if (missing.length) throw new SetupError(`Refusing: the PDF's opening pages do not say ${missing.map((m) => `"${m}"`).join(', ')}.`, 2)
    const printed = readPrintedPages(pages, { footer: edition.footer })
    offset = pageOffset(printed)
    if (offset.offset === null || offset.conflicts.length) {
      throw new SetupError(`Refusing: printed page numbers do not follow one offset (${offset.conflicts.length} pages disagree).`, 2)
    }
    entries = mapClauses(clauses, findClauseStarts(pages), printed)
    pageCount = pages.length
  }
  const mapped = entries.filter((e) => e.status === 'mapped')
  const ratio = mapped.length / clauses.length
  if (ratio < edition.min_match_ratio) {
    throw new SetupError(
      `Refusing: only ${mapped.length} of ${clauses.length} clauses of ${regsRef} open a paragraph of this PDF with their own text ` +
        `(${(ratio * 100).toFixed(1)}%). This is not that edition's document; nothing was changed.`,
      2,
    )
  }
  for (const e of mapped) {
    if (e.printed_page + offset.offset !== e.pdf_page || e.pdf_page < 1 || e.pdf_page > pageCount) {
      throw new SetupError(`internal: ${e.clause_key} page ${e.printed_page} does not land on PDF page ${e.pdf_page}`)
    }
  }
  const current = new Map(clauses.map((c) => [c.clause_key, c.source_page]))
  const toSet = mapped.filter((e) => current.get(e.clause_key) === null)
  const agreeing = mapped.filter((e) => current.get(e.clause_key) === e.printed_page)
  const conflicts = mapped
    .filter((e) => current.get(e.clause_key) !== null && current.get(e.clause_key) !== e.printed_page)
    .map((e) => ({ clause_key: e.clause_key, recorded: current.get(e.clause_key), found: e.printed_page }))
  const unresolved = entries.filter((e) => e.status !== 'mapped')

  // The document's source.
  const objectKey = `editions/${slug(regsRef)}/${fingerprint.slice(0, 16)}.pdf`
  let sourceDecision
  let replacedPath = null
  if (doc.url !== null) {
    sourceDecision = { kind: 'conflict', detail: 'the edition already points at an external URL; it was left as it is' }
  } else if (doc.storage_path === null || doc.storage_path === objectKey) {
    sourceDecision = { kind: doc.storage_path === null ? 'set' : 'current' }
  } else {
    const existing = await store.download(doc.storage_path)
    if (existing && sha256(existing) === fingerprint) {
      sourceDecision = {
        kind: 'repoint',
        detail: `${doc.storage_path} holds the same file; the row moves to the fingerprinted key and that object is left in place`,
      }
      replacedPath = doc.storage_path
    } else {
      sourceDecision = {
        kind: 'conflict',
        detail: existing
          ? `${doc.storage_path} is a different file (sha256 ${sha256(existing).slice(0, 16)}…); it was left as it is`
          : `${doc.storage_path} is configured but has no object behind it; it was left as it is — fix it in Settings, or clear it and run again`,
      }
    }
  }

  const summary = {
    edition: regsRef,
    season: season?.label ?? null,
    source: edition.source,
    sha256: fingerprint,
    page_count: pageCount,
    page_offset: offset.offset,
    object_key: objectKey,
    source_decision: sourceDecision.kind,
    source_detail: sourceDecision.detail ?? null,
    clauses: clauses.length,
    mapped: mapped.length,
    mapped_exact: mapped.filter((e) => e.match === 'exact').length,
    derived_from: reusable ? 'manifest (same file, same clauses)' : 'the PDF text',
    unmatched: unresolved.length,
    pages_to_set: toSet.length,
    pages_already_recorded: agreeing.length,
    page_conflicts: conflicts.length,
  }

  // The reproducible manifest, tied to the fingerprint (no timestamps: an
  // identical run writes an identical file).
  const manifest =
    JSON.stringify(
      {
        $comment:
          'Generated by npm run book:sync:local (scripts/book/bookMap.mjs). printed_page is clauses.source_page; pdf_page = printed_page + page_offset is the PDF page pdf.js opens.',
        generator: GENERATOR,
        edition: regsRef,
        source: edition.source,
        sha256: fingerprint,
        clauses_digest: clausesDigest,
        page_count: pageCount,
        page_offset: offset.offset,
        coverage: {
          clauses: clauses.length,
          mapped: mapped.length,
          exact: summary.mapped_exact,
          close: mapped.length - summary.mapped_exact,
          unmatched: unresolved.length,
        },
        unresolved: unresolved.map(({ clause_key, printed_ref, status, reason }) => ({ clause_key, printed_ref, status, reason })),
        entries: mapped.map(({ clause_key, printed_ref, printed_page, pdf_page, match, score, context }) => ({
          clause_key,
          printed_ref,
          printed_page,
          pdf_page,
          match,
          score,
          context,
        })),
      },
      null,
      1,
    ) + '\n'

  if (args.dryRun) {
    report({ ...summary, mode: 'dry run — nothing was written' }, conflicts, unresolved)
    return sourceDecision.kind === 'conflict' ? 2 : 0
  }
  if (sourceDecision.kind === 'conflict') {
    report({ ...summary, mode: 'stopped — the configured source conflicts; nothing was written' }, conflicts, unresolved)
    return 2
  }

  // 1. Stage the object, then prove it is the file.
  let object = 'present'
  const already = await store.download(objectKey)
  if (already && sha256(already) !== fingerprint) {
    throw new SetupError(`Refusing: ${config.bucket}/${objectKey} exists with different content. It was left as it is.`)
  }
  if (!already) {
    object = await store.upload(objectKey, bytes)
    const check = await store.download(objectKey)
    if (!check || sha256(check) !== fingerprint) throw new SetupError(`The uploaded object ${objectKey} does not read back as the same file.`)
  }
  if (args.simulateFailure === 'after-upload') {
    throw new SetupError('Simulated failure after the upload: the database was not changed. Run again to finish.')
  }

  // 2. One transaction: lock, re-check the source this plan was made against,
  //    then only the planned changes. Page updates touch NULL pages only, so a
  //    concurrent or repeated run cannot overwrite anything.
  const values = toSet.map((e) => `(${lit(e.clause_key)}, ${int(e.printed_page)})`).join(',\n    ')
  // The DO block below is dollar-quoted; no value placed inside it may carry
  // the quote tag.
  if ([regsRef, objectKey, replacedPath].some((v) => v !== null && v.includes('$book_sync$'))) {
    throw new SetupError('Refusing: a value would break the setup statement.')
  }
  const result = await psql(
    target,
    `begin;
select pg_advisory_xact_lock(hashtext('reqon.book-sync'));
do $book_sync$
declare r regulation_documents;
begin
  select * into r from regulation_documents where regs_ref = ${lit(regsRef)} for update;
  if not found then raise exception 'book sync: edition % has no regulation_documents row', ${lit(regsRef)}; end if;
  if r.url is not null or (r.storage_path is not null and r.storage_path is distinct from ${lit(objectKey)} and r.storage_path is distinct from ${lit(replacedPath)}::text) then
    raise exception 'book sync: the source of % changed while this run was planning; nothing was written — run it again', ${lit(regsRef)};
  end if;
end $book_sync$;
with doc as (
  update regulation_documents
     set storage_path = ${lit(objectKey)}, page_count = ${int(pageCount)}, page_offset = ${int(offset.offset)}
   where regs_ref = ${lit(regsRef)}
     and (storage_path is distinct from ${lit(objectKey)} or page_count is distinct from ${int(pageCount)} or page_offset is distinct from ${int(offset.offset)})
  returning 1
), found(clause_key, page) as (
  ${toSet.length ? `values\n    ${values}` : 'select null::text, null::int where false'}
), pages as (
  update clauses c set source_page = found.page
    from found
   where c.clause_key = found.clause_key and c.regs_ref = ${lit(regsRef)} and c.source_page is null
  returning 1
)
select json_build_object('document_changed', (select count(*) from doc), 'pages_set', (select count(*) from pages));
commit;
`,
  )
  const applied = JSON.parse(
    result
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .pop(),
  )

  // 3. Read it back.
  const after = await psqlJson(
    target,
    `select json_build_object('storage_path', (select storage_path from regulation_documents where regs_ref = ${lit(regsRef)}), 'recorded', (select count(source_page) from clauses where regs_ref = ${lit(regsRef)}))`,
  )
  if (after.storage_path !== objectKey) throw new SetupError('The document row does not name the uploaded object after the write.')

  const previous = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  if (previous !== manifest) writeFileSync(manifestPath, manifest)

  const changed = object === 'uploaded' || applied.document_changed > 0 || applied.pages_set > 0
  report(
    {
      ...summary,
      mode: changed ? 'applied' : 'no change — already set up',
      object,
      document_changed: applied.document_changed > 0,
      pages_set: applied.pages_set,
      pages_recorded_now: after.recorded,
      manifest: path.relative(REPO, manifestPath),
      manifest_written: previous !== manifest,
      legacy_object_left_in_place: replacedPath,
    },
    conflicts,
    unresolved,
  )
  return 0
}

function report(summary, conflicts, unresolved) {
  console.log('Requirements Book (local)')
  for (const [key, value] of Object.entries(summary)) {
    if (value !== null && value !== undefined) console.log(`  ${key.padEnd(24)} ${value}`)
  }
  if (conflicts.length) {
    console.log('  page conflicts (recorded page kept):')
    for (const c of conflicts.slice(0, 20)) console.log(`    ${c.clause_key}: recorded ${c.recorded}, the PDF says ${c.found}`)
  }
  if (unresolved.length) {
    console.log('  not mapped (left as recorded, listed for review):')
    for (const u of unresolved.slice(0, 20)) console.log(`    ${u.clause_key}: ${u.reason}`)
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`book:sync:local — ${error instanceof SetupError ? error.message : (error.stack ?? error)}`)
    process.exit(error instanceof SetupError ? error.code : 1)
  },
)
