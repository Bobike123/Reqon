import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The panel's own behaviour that the Spec Sheet tests cannot reach: what happens to a half-written note when
// the current measurement changes underneath it, and to an open withdrawal form when the confirmation lapses.

const confirmMutate = vi.fn()
const revokeMutate = vi.fn()
vi.mock('../../data/useSpecs.ts', () => ({
  useConfirmReadiness: () => ({ mutate: confirmMutate, isPending: false, error: null }),
  useRevokeReadiness: () => ({ mutate: revokeMutate, isPending: false, error: null }),
  useReviewDirection: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

const { ReadinessPanel } = await import('./ReadinessPanel.tsx')

type Props = Parameters<typeof ReadinessPanel>[0]
const spec = (patch: Record<string, unknown> = {}) =>
  ({
    id: 'spec-1', verdict: 'pass', measured: 12, measured_bool: null, unit: 'kg', measured_at: '2026-09-20T10:00:00Z',
    current_measurement_id: 'meas-a', readiness: 'not_confirmed', readiness_reason: null, readiness_confirmed_at: null,
    readiness_confirmed_by: null, readiness_note: null, ...patch,
  }) as unknown as Props['spec']

beforeEach(() => {
  confirmMutate.mockReset()
  revokeMutate.mockReset()
})

describe('ReadinessPanel', () => {
  it('starts the note over when the current measurement changes, so a note is never confirmed against a different measurement', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ReadinessPanel spec={spec()} canManage memberNames={new Map()} />)
    await user.type(screen.getByLabelText('What was checked?'), 'Weighed on the scale')
    rerender(<ReadinessPanel spec={spec({ current_measurement_id: 'meas-b', measured: 13 })} canManage memberNames={new Map()} />)
    expect(screen.getByLabelText('What was checked?')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Confirm ready' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('13 kg')
  })

  it('sends the measurement the form was opened for, and keeps the note if the command is refused', async () => {
    const user = userEvent.setup()
    render(<ReadinessPanel spec={spec()} canManage memberNames={new Map()} />)
    await user.type(screen.getByLabelText('What was checked?'), 'Checked twice')
    await user.click(screen.getByRole('button', { name: 'Confirm ready' }))
    expect(confirmMutate).toHaveBeenCalledWith(
      { specId: 'spec-1', measurementId: 'meas-a', note: 'Checked twice' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
    // Not cleared until the command succeeded.
    expect(screen.getByLabelText('What was checked?')).toHaveValue('Checked twice')
  })

  it('closes an open withdrawal form when the confirmation lapsed elsewhere', async () => {
    const user = userEvent.setup()
    const ready = spec({ readiness: 'ready', readiness_confirmed_at: '2026-09-21T10:00:00Z', readiness_note: 'ok' })
    const { rerender } = render(<ReadinessPanel spec={ready} canManage memberNames={new Map()} />)
    await user.click(screen.getByRole('button', { name: 'Withdraw confirmation…' }))
    expect(screen.getByLabelText('Why is it being withdrawn?')).toBeInTheDocument()
    rerender(<ReadinessPanel spec={spec({ readiness: 'lapsed', readiness_reason: 'A newer measurement became the current one.' })} canManage memberNames={new Map()} />)
    await waitFor(() => expect(screen.queryByLabelText('Why is it being withdrawn?')).not.toBeInTheDocument())
  })
})
