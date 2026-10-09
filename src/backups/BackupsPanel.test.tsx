import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupRun } from '../data/useBackups.ts'
import { BackupsPanel } from './BackupsPanel.tsx'
import { backupsEnabled } from './flag.ts'

const h = vi.hoisted(() => ({ rows: [] as unknown[], error: null as unknown, invoke: vi.fn() }))

vi.mock('../lib/supabase.ts', () => ({
  supabase: {
    from: () => {
      const q = {
        select: () => q,
        order: () => q,
        limit: () => q,
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
          Promise.resolve(h.error ? { data: null, error: h.error } : { data: h.rows, error: null }).then(ok, bad),
      }
      return q
    },
    functions: { invoke: (...args: unknown[]) => h.invoke(...args) },
  },
}))

const NOW = new Date('2026-10-08T12:00:00Z')
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
const SHA = 'c0ffee'.padEnd(64, '1')
const base = (over: Partial<BackupRun>): BackupRun => ({
  id: 1, destination: 'r2', taken_at: ago(9), ok: true, object_key: 'daily/reqon-backup-20261008T031700Z.tar.age', size_bytes: 860666, sha256: SHA,
  migration_version: '20260133000000', db_size_bytes: 25_000_000, row_count: 4010, recipients: ['331b42d7939c739e', '6a2e7461c39ab98e'], detail: null, ...over,
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BackupsPanel now={NOW} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  h.rows = []
  h.error = null
  h.invoke.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('Settings → Backups', () => {
  it('shows each destination with its proof when everything is fine', async () => {
    h.rows = [base({}), base({ id: 2, destination: 'github', taken_at: ago(70) }), base({ id: 3, destination: 'drive', taken_at: ago(70) })]
    renderPanel()
    expect(await screen.findByTestId('backups-overall')).toHaveTextContent('Backups are running.')
    const r2 = screen.getByTestId('backup-r2')
    expect(within(r2).getByText('OK')).toBeInTheDocument()
    expect(within(r2).getByText('Last backup 9 hours ago.')).toBeInTheDocument()
    expect(within(r2).getByTestId('backup-sha-r2')).toHaveTextContent(SHA)
    expect(within(r2).getByText('2 keys')).toBeInTheDocument()
    expect(within(r2).getByText('331b42d7939c739e 6a2e7461c39ab98e')).toBeInTheDocument()
    expect(within(r2).getByText('861 kB · 4,010 rows')).toBeInTheDocument()
    expect(screen.getByTestId('backup-github')).toHaveTextContent('Last backup 2 days ago.')
  })

  it('turns into an alert when the newest daily backup is too old', async () => {
    h.rows = [base({ taken_at: ago(60) })]
    renderPanel()
    const overall = await screen.findByTestId('backups-overall')
    expect(overall).toHaveAttribute('role', 'alert')
    expect(overall).toHaveTextContent('The daily backup needs attention.')
    expect(within(screen.getByTestId('backup-r2')).getByText('Overdue')).toBeInTheDocument()
  })

  it('reports a failed attempt in words and keeps the last good one visible', async () => {
    h.rows = [base({ id: 2, taken_at: ago(3), ok: false, detail: 'dump_too_big', size_bytes: null, sha256: null, migration_version: null }), base({ id: 1, taken_at: ago(27) })]
    renderPanel()
    expect(await screen.findByTestId('backups-overall')).toHaveTextContent('the dump is over the size limit set for backups')
    expect(within(screen.getByTestId('backup-r2')).getByText('Failed')).toBeInTheDocument()
    expect(screen.getByTestId('backup-sha-r2')).toHaveTextContent(SHA)
  })

  it('says plainly when nothing has been recorded, and disables the download', async () => {
    renderPanel()
    expect(await screen.findByTestId('backups-overall')).toHaveTextContent('No backup has run yet')
    expect(screen.getByTestId('backup-download')).toBeDisabled()
  })

  it('downloads the newest backup through a signed link and shows the checksum to compare', async () => {
    h.rows = [base({})]
    h.invoke.mockResolvedValue({ data: { url: 'https://r2.test/daily/x?sig=1', expiresIn: 600, name: 'reqon-backup-20261008T031700Z.tar.age', sizeBytes: 860666, sha256: SHA, takenAt: ago(9) }, error: null })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderPanel()
    await userEvent.click(await screen.findByTestId('backup-download'))
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('backup-download-url', { body: {} }))
    expect(click).toHaveBeenCalled()
    expect(await screen.findByTestId('backup-saved')).toHaveTextContent(`reqon-backup-20261008T031700Z.tar.age`)
    expect(screen.getByTestId('backup-saved')).toHaveTextContent(SHA)
    click.mockRestore()
  })

  it('shows a refused download (403) as a permission message', async () => {
    h.rows = [base({})]
    h.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('refused'), { context: new Response(JSON.stringify({ error: 'There is no backup you can download.' }), { status: 403 }) }),
    })
    renderPanel()
    await userEvent.click(await screen.findByTestId('backup-download'))
    expect(await screen.findByText(/There is no backup you can download/)).toBeInTheDocument()
    expect(screen.getByText('Not permitted:')).toBeInTheDocument()
  })

  it('a failed load offers Try again', async () => {
    h.error = { message: 'boom', code: 'XX000', details: '', hint: '' }
    renderPanel()
    expect(await screen.findByText('Could not load the backup status')).toBeInTheDocument()
    h.error = null
    h.rows = [base({})]
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('backups-overall')).toBeInTheDocument()
  })
})

describe('feature flag', () => {
  it('is on only for the exact string "true"', () => {
    expect(backupsEnabled({ VITE_BACKUPS_ENABLED: 'true' })).toBe(true)
    expect(backupsEnabled({})).toBe(false)
    expect(backupsEnabled({ VITE_BACKUPS_ENABLED: '1' })).toBe(false)
  })
})
