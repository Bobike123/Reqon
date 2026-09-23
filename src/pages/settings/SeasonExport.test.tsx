import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The season handover download: it must export the season the club is
// actually working in (by id, not "whatever loads"), say when it is busy, and
// never report or download a result when building the export failed.

let currentSeason: { data: { id: string; label: string } | undefined } = { data: undefined }
vi.mock('../../data/useCurrentSeason.ts', () => ({ useCurrentSeason: () => currentSeason }))

const buildSeasonExport = vi.fn()
const downloadJson = vi.fn()
vi.mock('../../data/exportSeason.ts', () => ({
  buildSeasonExport: (...args: unknown[]) => buildSeasonExport(...args),
  downloadJson: (...args: unknown[]) => downloadJson(...args),
}))

const { SeasonExport } = await import('./SeasonExport.tsx')

beforeEach(() => {
  currentSeason = { data: { id: 'season-a', label: '2026/27' } }
  buildSeasonExport.mockReset()
  downloadJson.mockReset()
})

describe('SeasonExport', () => {
  it('exports the current season by its id and names the file after it', async () => {
    const payload = { season: { id: 'season-a' }, counts: {} }
    buildSeasonExport.mockResolvedValue(payload)
    render(<SeasonExport />)

    await userEvent.click(screen.getByRole('button', { name: 'Download season JSON' }))

    await waitFor(() => expect(downloadJson).toHaveBeenCalledTimes(1))
    expect(buildSeasonExport).toHaveBeenCalledWith('season-a')
    const [filename, data] = downloadJson.mock.calls[0]
    expect(filename).toMatch(/^reqon-2026-27-\d{4}-\d{2}-\d{2}\.json$/)
    expect(data).toBe(payload)
  })

  it('is busy and disabled while the export is being built, then usable again', async () => {
    let finish: (value: unknown) => void = () => {}
    buildSeasonExport.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    render(<SeasonExport />)

    await userEvent.click(screen.getByRole('button', { name: 'Download season JSON' }))
    const busy = screen.getByRole('button', { name: 'Preparing…' })
    expect(busy).toBeDisabled()

    finish({})
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download season JSON' })).toBeEnabled())
  })

  it('shows the failure and downloads nothing when the export cannot be built', async () => {
    buildSeasonExport.mockRejectedValue(new Error('Could not load tasks: connection lost'))
    render(<SeasonExport />)

    await userEvent.click(screen.getByRole('button', { name: 'Download season JSON' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tasks: connection lost')
    expect(downloadJson).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Download season JSON' })).toBeEnabled()
  })

  it('cannot export before the current season is known', async () => {
    currentSeason = { data: undefined }
    render(<SeasonExport />)

    const button = screen.getByRole('button', { name: 'Download season JSON' })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(buildSeasonExport).not.toHaveBeenCalled()
  })
})
