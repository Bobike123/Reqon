#!/usr/bin/env node
// Turns the data of a decrypted backup into SQL that loads it into the restore_staging schema
// (Ultraplan Phase 5; RST-01). Never into public: every table becomes restore_staging.s_<schema>__<table>
// with TEXT columns (plus a row number _n), registered in restore_staging.tables; the restore functions
// cast each value to the live column's type when (and only when) they write it.
//
//   pg_restore --data-only -f - public.dump | node stage.mjs --name <backup file name> --manifest manifest.json
//
// Input is pg_restore's plain-SQL output: everything except COPY blocks is ignored (SET statements,
// sequence values — the restore moves sequences itself). COPY text format is kept byte for byte: a value is
// stored exactly as the dump wrote it, and Postgres parses it with the column's own input function later.
// Several dumps may be concatenated on stdin. Streams; holds one line at a time.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Parses one SQL identifier (bare or "quoted") at position i; returns [name, next position].
export function readIdent(text, i) {
  if (text[i] === '"') {
    let out = ''
    let j = i + 1
    for (;;) {
      if (j >= text.length) throw new Error(`unterminated identifier in: ${text}`)
      if (text[j] === '"') {
        if (text[j + 1] === '"') {
          out += '"'
          j += 2
          continue
        }
        return [out, j + 1]
      }
      out += text[j]
      j += 1
    }
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i))
  if (!m) throw new Error(`not an identifier at ${i} in: ${text}`)
  // Unquoted identifiers are folded to lower case by Postgres; pg_dump only leaves them unquoted when lower case.
  return [m[0], i + m[0].length]
}

// "COPY public.tasks (id, title, "order") FROM stdin;" → { schema, table, columns }
export function parseCopyHeader(line) {
  if (!line.startsWith('COPY ') || !line.endsWith(' FROM stdin;')) return null
  const body = line.slice(5, -' FROM stdin;'.length)
  let [schema, i] = readIdent(body, 0)
  if (body[i] !== '.') throw new Error(`expected schema.table in: ${line}`)
  let table
  ;[table, i] = readIdent(body, i + 1)
  if (body.slice(i, i + 2) !== ' (' || !body.endsWith(')')) throw new Error(`expected a column list in: ${line}`)
  const list = body.slice(i + 2, -1)
  const columns = []
  let j = 0
  while (j < list.length) {
    const [col, next] = readIdent(list, j)
    columns.push(col)
    j = next
    if (list.slice(j, j + 2) === ', ') j += 2
    else if (j < list.length) throw new Error(`unexpected text in the column list of: ${line}`)
  }
  return { schema, table, columns }
}

const q = (id) => `"${id.replaceAll('"', '""')}"`
const lit = (s) => `'${s.replaceAll("'", "''")}'`
function stagingName(schema, table) {
  const raw = `s_${schema}__${table}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return raw.length <= 63 ? raw : `${raw.slice(0, 54)}_${raw.length.toString(16)}${raw.charCodeAt(raw.length - 1).toString(16)}`
}

// A dollar-quote tag that does not occur in the text.
function dollarQuote(text) {
  let tag = 'm'
  while (text.includes(`$${tag}$`)) tag += 'x'
  return `$${tag}$${text}$${tag}$`
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const name = opt('--name')
  const manifestFile = opt('--manifest')
  if (!name || !manifestFile) {
    console.error('usage: stage.mjs --name <backup file name> --manifest <manifest.json>  (pg_restore -f - output on stdin)')
    process.exit(2)
  }
  if (!/^reqon-backup-\d{8}T\d{6}Z\.tar\.age$/.test(name)) {
    console.error('stage.mjs: the backup name does not look like reqon-backup-<stamp>.tar.age')
    process.exit(2)
  }
  const manifestText = readFileSync(manifestFile, 'utf8').trim()
  const manifest = JSON.parse(manifestText)
  if (manifest.format !== 1 || !manifest.migration_version || !manifest.tables) {
    console.error('stage.mjs: the manifest is not a format-1 Reqon backup manifest')
    process.exit(2)
  }

  const out = process.stdout
  const write = (s) => {
    if (!out.write(s)) return new Promise((resolve) => out.once('drain', resolve))
    return null
  }
  const stamp = /^reqon-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name)
  const takenAt = `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`

  await write('set client_min_messages = warning;\nselect restore.reset_staging();\n')
  await write(`insert into restore_staging.meta (backup_name, backup_taken_at, migration_version, manifest) values (${lit(name)}, ${lit(takenAt)}, ${lit(manifest.migration_version)}, ${dollarQuote(manifestText)}::jsonb);\n`)

  const seen = new Set()
  let inCopy = false
  let rows = 0
  const counts = {}
  let current = null
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (inCopy) {
      const p = write(`${line}\n`)
      if (p) await p
      if (line === '\\.') {
        inCopy = false
        counts[current] = rows
      } else {
        rows += 1
      }
      continue
    }
    const header = parseCopyHeader(line)
    if (!header) continue
    const staging = stagingName(header.schema, header.table)
    const key = `${header.schema}.${header.table}`
    if (seen.has(key)) throw new Error(`table ${key} appears twice in the dump`)
    seen.add(key)
    const cols = header.columns.map(q).join(', ')
    await write(
      `create table restore_staging.${q(staging)} (_n bigint generated always as identity primary key, ${header.columns.map((c) => `${q(c)} text`).join(', ')});\n` +
        `insert into restore_staging.tables (staging_table, source_schema, source_table, columns) values (${lit(staging)}, ${lit(header.schema)}, ${lit(header.table)}, array[${header.columns.map(lit).join(', ')}]::text[]);\n` +
        `copy restore_staging.${q(staging)} (${cols}) from stdin;\n`,
    )
    inCopy = true
    rows = 0
    current = key
  }
  if (inCopy) throw new Error('the dump ended inside a COPY block (truncated?)')
  const tables = Object.keys(counts).length
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  process.stderr.write(`stage: ${tables} table(s), ${total} row(s) staged\n`)
}
