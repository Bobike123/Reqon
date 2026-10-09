import { describe, expect, it } from 'vitest'
import type { BackupRun } from '../data/useBackups.ts'
import { backupHealth, describeRun, failureText, formatAge, overallMessage } from './status.ts'

const NOW = new Date('2026-10-08T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
let id = 0
function run(destination: BackupRun['destination'], hours: number, over: Partial<BackupRun> = {}): BackupRun {
  id += 1
  return {
    id, destination, taken_at: hoursAgo(hours), ok: true, object_key: null, size_bytes: 860666, sha256: 'a'.repeat(64),
    migration_version: '20260133000000', db_size_bytes: 25_000_000, row_count: 4010, recipients: ['331b42d7939c739e'], detail: null, ...over,
  }
}
const fail = (destination: BackupRun['destination'], hours: number, detail: string | null) =>
  run(destination, hours, { ok: false, detail, size_bytes: null, sha256: null, migration_version: null })
const by = (runs: BackupRun[]) => Object.fromEntries(backupHealth(runs, NOW).map((h) => [h.destination, h]))

describe('backupHealth', () => {
  it('nothing recorded → "never" for all three', () => {
    const h = backupHealth([], NOW)
    expect(h.map((x) => x.state)).toEqual(['never', 'never', 'never'])
    expect(h[0].message).toBe('No backup has been recorded yet.')
  })

  it('a recent daily backup is ok; the weekly copies have their own, longer tolerance', () => {
    const h = by([run('r2', 5), run('github', 100), run('drive', 8 * 24)])
    expect(h.r2).toMatchObject({ state: 'ok', message: 'Last backup 5 hours ago.' })
    expect(h.github.state).toBe('ok')
    expect(h.drive.state).toBe('ok')
  })

  it('the daily backup turns stale just after 48 hours, the weekly ones after 9 days', () => {
    expect(by([run('r2', 47.9)]).r2.state).toBe('ok')
    expect(by([run('r2', 48.1)]).r2).toMatchObject({ state: 'stale', message: 'The newest backup is 2 days ago; one is expected every day.' })
    expect(by([run('github', 9 * 24 - 1)]).github.state).toBe('ok')
    expect(by([run('github', 9 * 24 + 1)]).github.state).toBe('stale')
  })

  it('a failed latest attempt is "failed" even when an older one was good, and says how old the good one is', () => {
    const h = by([run('r2', 30), fail('r2', 6, 'dump_too_big')])
    expect(h.r2.state).toBe('failed')
    expect(h.r2.message).toBe('The latest attempt failed: the dump is over the size limit set for backups. The last good one was 30 hours ago.')
    expect(h.r2.lastOk?.id).toBeDefined()
  })

  it('a failure with no good backup at all says so', () => {
    expect(by([fail('drive', 1, 'upload_failed')]).drive.message).toContain('There is no good one yet.')
  })

  it('a good backup after a failure is ok again (the order is by time, not by id)', () => {
    const later = run('r2', 2)
    const earlier = fail('r2', 20, 'database_busy')
    expect(by([later, earlier]).r2.state).toBe('ok')
    expect(by([earlier, later]).r2.state).toBe('ok')
  })

  it('exposes the newest good run for the details', () => {
    const newest = run('r2', 3, { sha256: 'b'.repeat(64) })
    expect(by([run('r2', 27), newest, run('r2', 51)]).r2.lastOk?.sha256).toBe('b'.repeat(64))
  })
})

describe('overallMessage', () => {
  it('all well', () => {
    expect(overallMessage(backupHealth([run('r2', 2), run('github', 24), run('drive', 24)], NOW))).toEqual({ tone: 'ok', text: 'Backups are running.' })
  })
  it('a problem with the daily backup is the loudest', () => {
    const o = overallMessage(backupHealth([fail('r2', 1, 'connection_failed'), run('github', 24), run('drive', 24)], NOW))
    expect(o.tone).toBe('bad')
    expect(o.text).toContain('the database could not be reached or refused the login')
  })
  it('no backup yet is a warning, not an error', () => {
    expect(overallMessage(backupHealth([], NOW)).tone).toBe('warn')
  })
  it('a weekly copy that failed is a warning', () => {
    const o = overallMessage(backupHealth([run('r2', 2), fail('github', 3, 'push_failed'), run('drive', 24)], NOW))
    expect(o.tone).toBe('warn')
    expect(o.text).toContain('Private GitHub repository')
  })
})

describe('wording', () => {
  it('translates the codes the scripts write and defuses unknown ones', () => {
    expect(failureText('database_busy')).toBe('the data kept changing while it was being copied')
    expect(failureText(null)).toBe('the reason was not recorded')
    expect(failureText('weird<script>code')).toBe('code “weirdscriptcode”')
  })
  it('ages read naturally', () => {
    expect(formatAge(0.2)).toBe('less than an hour ago')
    expect(formatAge(1)).toBe('1 hour ago')
    expect(formatAge(5.4)).toBe('5 hours ago')
    expect(formatAge(47)).toBe('47 hours ago')
    expect(formatAge(50)).toBe('2 days ago')
  })
  it('summarises a run', () => {
    expect(describeRun(run('r2', 1))).toBe('861 kB · 4,010 rows')
    expect(describeRun(run('r2', 1, { size_bytes: null, row_count: null }))).toBe('')
  })
})
