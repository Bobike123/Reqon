import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary.tsx'

function Boom({ fail }: { fail: boolean }): React.ReactElement {
  if (fail) throw new Error('subteam list is not iterable')
  return <p>screen content</p>
}

beforeEach(() => {
  // React logs the caught error itself; silence it so the run stays readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('a render crash', () => {
  it('shows a real message instead of a blank page', () => {
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>)
    expect(screen.getByText('Something broke on this screen')).toBeInTheDocument()
    // The specific failure is visible — "it went blank" is unreportable.
    expect(screen.getByRole('alert')).toHaveTextContent('subteam list is not iterable')
    // And the page is not empty.
    expect(document.body.textContent?.trim().length).toBeGreaterThan(20)
  })

  it('offers a way out: retry and a link home', () => {
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Now' })).toHaveAttribute('href', '/')
  })

  it('reassures the reader that saved work is safe', () => {
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>)
    expect(screen.getByText(/Nothing you had saved is lost/)).toBeInTheDocument()
  })

  it('recovers when the underlying problem is gone', async () => {
    const user = userEvent.setup()
    function App({ fail }: { fail: boolean }) {
      return <ErrorBoundary><Boom fail={fail} /></ErrorBoundary>
    }
    const { rerender } = render(<App fail />)
    expect(screen.getByText('Something broke on this screen')).toBeInTheDocument()
    rerender(<App fail={false} />)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('screen content')).toBeInTheDocument()
  })

  it('stays out of the way when nothing throws', () => {
    render(<ErrorBoundary><Boom fail={false} /></ErrorBoundary>)
    expect(screen.getByText('screen content')).toBeInTheDocument()
    expect(screen.queryByText('Something broke on this screen')).not.toBeInTheDocument()
  })

  it('logs the crash so a bug report has something to go on', () => {
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>)
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(logged.some((c) => String(c[0]).includes('crashed while rendering'))).toBe(true)
  })
})
