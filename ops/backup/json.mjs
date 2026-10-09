#!/usr/bin/env node
// JSON helper for the backup shell scripts (Ultraplan Phase 4) — Node is already required by this repo, so
// neither the workflow runner nor a key holder's laptop needs `jq`.
//
//   json.mjs manifest <query.json> <stamp> <db-bytes> <name=bytes:sha256>...   → manifest.json on stdout
//   json.mjs meta <manifest.json> <stamp> <file-name> <sha256> <size> <db-bytes> <fp,fp,…>   → meta.json
//   json.mjs get <file.json> <key/path>        → one value, empty when absent
//   json.mjs summary <manifest.json>              → "<tables> <rows> <migration>"
//   json.mjs diff <manifest.json> <live-query.json> [--ignore p,…] [--rows-only p,…]   → one line per differing table; exit 1 when any
//   json.mjs record <meta.json|-> <destination> <ok|fail> [detail]   → body for the backup-record function
//   json.mjs age-hours <rclone lsjson file> [now-iso]   → hours since the newest backup file name's stamp, or "none"
//
// Prints counts, names and hashes of files — never row contents.
import { readFileSync } from 'node:fs'

const [command, ...args] = process.argv.slice(2)
const read = (file) => JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'))
const out = (value) => process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`)
const rowsOf = (tables) => Object.values(tables).reduce((n, t) => n + Number(t.rows), 0)

function fail(message) {
  console.error(`json.mjs: ${message}`)
  process.exit(2)
}

switch (command) {
  case 'manifest': {
    const [queryFile, stamp, dbBytes, ...files] = args
    if (!queryFile || !stamp || !dbBytes || files.length === 0) fail('usage: manifest <query.json> <stamp> <db-bytes> <name=bytes:sha256>...')
    const query = read(queryFile)
    const entries = Object.fromEntries(
      files.map((f) => {
        const m = /^([\w.-]+)=(\d+):([0-9a-f]{64})$/.exec(f)
        if (!m) fail(`bad file argument: ${f}`)
        return [m[1], { bytes: Number(m[2]), sha256: m[3] }]
      }),
    )
    out({ ...query, format: 1, taken_at: stamp, db_size_bytes: Number(dbBytes), files: entries })
    break
  }
  case 'meta': {
    const [manifestFile, stamp, name, sha, size, dbBytes, fps] = args
    const manifest = read(manifestFile)
    out({
      format: 1,
      stamp,
      file: name,
      sha256: sha,
      size_bytes: Number(size),
      migration_version: manifest.migration_version,
      db_size_bytes: Number(dbBytes),
      row_count: rowsOf(manifest.tables),
      table_count: Object.keys(manifest.tables).length,
      recipients: (fps ?? '').split(',').filter(Boolean),
    })
    break
  }
  case 'get': {
    const [file, path] = args
    const value = path.split('/').reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), read(file))
    out(value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
    break
  }
  case 'summary': {
    const m = read(args[0])
    out(`${Object.keys(m.tables).length} ${rowsOf(m.tables)} ${m.migration_version ?? ''}`)
    break
  }
  case 'diff': {
    // diff <a> <b> [--ignore prefix,…] [--rows-only prefix,…]   (prefixes match "schema." or "schema.table")
    const listOpt = (name) => {
      const i = args.indexOf(name)
      return i >= 0 ? (args[i + 1] ?? '').split(',').filter(Boolean) : []
    }
    const ignore = listOpt('--ignore')
    const rowsOnly = listOpt('--rows-only')
    const starts = (t, prefixes) => prefixes.some((p) => t === p || t.startsWith(p))
    const a = read(args[0]).tables
    const b = read(args[1]).tables
    const lines = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .filter((t) => !starts(t, ignore))
      .filter((t) => a[t]?.rows !== b[t]?.rows || (!starts(t, rowsOnly) && a[t]?.md5 !== b[t]?.md5))
      .map((t) => `${t} (backup ${a[t]?.rows ?? 'absent'} rows, live ${b[t]?.rows ?? 'absent'})`)
    if (lines.length > 0) {
      process.stdout.write(`${lines.join('\n')}\n`)
      process.exit(1)
    }
    break
  }
  case 'record': {
    const [metaFile, destination, status, detail] = args
    const ok = status === 'ok'
    const meta = metaFile === '-' ? null : read(metaFile)
    const key = meta && destination === 'r2' ? `${meta.stamp && process.env.BACKUP_R2_FOLDER ? process.env.BACKUP_R2_FOLDER : 'daily'}/${meta.file}` : null
    out({
      destination,
      ok,
      taken_at: meta ? new Date(meta.stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')).toISOString() : new Date().toISOString(),
      object_key: ok ? key : null,
      size_bytes: ok && meta ? meta.size_bytes : null,
      sha256: ok && meta ? meta.sha256 : null,
      migration_version: ok && meta ? meta.migration_version : null,
      db_size_bytes: meta ? meta.db_size_bytes : null,
      row_count: meta ? meta.row_count : null,
      recipients: meta ? meta.recipients : [],
      detail: detail ?? null,
    })
    break
  }
  case 'age-hours': {
    const now = args[1] ? new Date(args[1]).getTime() : Date.now()
    const stamps = read(args[0])
      .map((f) => /^reqon-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.age$/.exec(f.Name ?? f.Path ?? ''))
      .filter(Boolean)
      .map((m) => Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`))
    out(stamps.length === 0 ? 'none' : ((now - Math.max(...stamps)) / 3_600_000).toFixed(1))
    break
  }
  default:
    fail(`unknown command: ${command ?? '(none)'}`)
}
