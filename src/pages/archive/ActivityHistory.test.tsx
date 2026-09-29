import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const enabledCalls: boolean[] = []
const fetchNextPage = vi.fn()

vi.mock('../../data/useActivityHistory.ts', () => ({
  useActivityHistory: (_entity: string, _id: string, enabled: boolean) => {
    enabledCalls.push(enabled)
    return {
      data: enabled ? {
        rows: [
          { id: 2, season_id: 's1', entity: 'task', entity_id: 't1', action: 'archived', actor_id: null, at: '2026-09-24T12:00:00Z', detail: { actor_kind: 'system', reason: 'auto_done_24h' } },
          { id: 1, season_id: 's1', entity: 'task', entity_id: 't1', action: 'created_from_proposal', actor_id: 'm1', at: '2026-09-23T12:00:00Z', detail: { proposal_id: 'p1' } },
        ],
      } : undefined,
      isLoading: false, error: null, hasNextPage: enabled, isFetchingNextPage: false, fetchNextPage,
    }
  },
}))

const { ActivityHistory } = await import('./ActivityHistory.tsx')

describe('ActivityHistory', () => {
  it('is lazy, then shows readable who/what/when, a non-colour icon and provenance', async () => {
    enabledCalls.length = 0
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ActivityHistory entity="task" entityId="t1" memberNames={new Map([['m1', 'Ada Rider']])} />
      </MemoryRouter>,
    )

    expect(enabledCalls.at(-1)).toBe(false)
    expect(screen.queryByTestId('activity-history-t1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show change history' }))
    expect(enabledCalls.at(-1)).toBe(true)
    const history = screen.getByTestId('activity-history-t1')
    expect(history).toHaveTextContent('Archived automatically after 24 hours Done')
    expect(history).toHaveTextContent('Automatic archive scheduler')
    expect(history).toHaveTextContent('Created from an approved proposal')
    expect(history).toHaveTextContent('Ada Rider')
    expect(screen.getByRole('link', { name: 'Open source proposal' })).toHaveAttribute('href', '/archive?tab=proposals&id=p1')
    expect(history.querySelector('[aria-hidden="true"]')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load older changes' }))
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })
})
