import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Meetings screen over mocked data hooks: how stored Markdown is read, and
// how the default agenda is edited. Who may do what is the database's
// (20260108 policies, checked in supabase/tests); here only which controls the
// screen offers for each permission, and that it never loses typed text.
const state = vi.hoisted(() => ({
  can: { canCreateMeeting: false, canDeleteMeeting: false, canEditMeetingTemplate: false },
  meetings: [] as Record<string, unknown>[],
  template: '## Agenda\n\n- ',
  saveError: null as Error | null,
  saved: [] as string[],
  created: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  deleted: [] as string[],
  writeError: null as Error | null,
}))

vi.mock('../auth/usePermissions.ts', () => ({ usePermissions: () => state.can }))
vi.mock('../data/useMeetings.ts', async () => {
  const { useState } = await import('react')
  return {
  useMeetings: () => ({ data: state.meetings, error: null, isPending: false, refetch: vi.fn() }),
  useMeetingTemplate: () => ({ data: state.template, error: null, isPending: false }),
  useDeleteMeeting: () => ({ mutateAsync: async (id: string) => { state.deleted.push(id) }, reset: vi.fn(), isPending: false, error: null }),
  useCreateMeeting: () => {
    const [error, setError] = useState<Error | null>(null)
    return {
      reset: () => setError(null), isPending: false, error,
      mutateAsync: async (draft: Record<string, unknown>) => {
        if (state.writeError) { setError(state.writeError); throw state.writeError }
        state.created.push(draft)
      },
    }
  },
  useUpdateMeeting: () => ({ mutateAsync: async (draft: Record<string, unknown>) => { state.updated.push(draft) }, reset: vi.fn(), isPending: false, error: null }),
  useSaveMeetingTemplate: () => {
    const [error, setError] = useState<Error | null>(null)
    return {
      isPending: false,
      error,
      reset: () => setError(null),
      mutateAsync: async (body: string) => {
        if (state.saveError) {
          setError(state.saveError)
          throw state.saveError
        }
        state.saved.push(body)
      },
    }
  },
  }
})

const { default: Meetings } = await import('./Meetings.tsx')

const meeting = (over: Record<string, unknown> = {}) => ({
  id: 'm1', season_id: 's1', title: 'Weekly build', held_on: '2026-09-10', starts_at: '18:00:00', ends_at: null,
  location: 'Workshop', agenda: null, notes: null, attendees: null, summary: null, created_by: null,
  created_at: '', updated_at: '', ...over,
})

const renderPage = () => render(<MemoryRouter><Meetings /></MemoryRouter>)

beforeEach(() => {
  state.can = { canCreateMeeting: false, canDeleteMeeting: false, canEditMeetingTemplate: false }
  state.meetings = []
  state.template = '## Agenda\n\n- '
  state.saveError = null
  state.saved = []
  state.created = []
  state.updated = []
  state.deleted = []
  state.writeError = null
})

describe('reading a meeting', () => {
  it('draws stored Markdown as headings, paragraphs and nested lists', async () => {
    state.meetings = [meeting({ agenda: '## Build status\n\nWhere we are.\n\n- Frame\n  - welds checked\n  - jig ordered\n- Fairing', notes: '**Decided:** order tyres.' })]
    renderPage()
    const agenda = await screen.findByTestId('meeting-agenda-m1')
    // A heading one level below the meeting's own title.
    expect(await within(agenda).findByRole('heading', { level: 4, name: 'Build status' })).toBeInTheDocument()
    expect(within(agenda).getByText('Where we are.').tagName).toBe('P')
    const outer = within(agenda).getAllByRole('list')[0]
    const frame = within(outer).getByText('Frame').closest('li') as HTMLElement
    expect(within(frame).getByRole('list')).toHaveTextContent('welds checked')
    expect(within(screen.getByTestId('meeting-notes-m1')).getByText('Decided:').tagName).toBe('STRONG')
  })

  it('never renders raw HTML or a script link from the stored text', async () => {
    state.meetings = [meeting({ agenda: 'Hi <img src="x" onerror="alert(1)"> <script>alert(2)</script>\n\n[click](javascript:alert(3)) and [site](https://example.org)' })]
    renderPage()
    const agenda = await screen.findByTestId('meeting-agenda-m1')
    await within(agenda).findByRole('link', { name: /site/ })
    expect(agenda.querySelector('img, script')).toBeNull()
    expect(within(agenda).getByRole('link', { name: /site/ })).toHaveAttribute('href', 'https://example.org')
    expect(within(agenda).getByText('click').closest('a')?.getAttribute('href') ?? '').not.toMatch(/javascript/i)
  })
})

describe('the default agenda', () => {
  it('is not offered to someone who neither calls meetings nor edits it', () => {
    renderPage()
    expect(screen.queryByText('Default agenda for new meetings')).not.toBeInTheDocument()
  })

  it('is readable, but not editable, by a Vice President who calls meetings', async () => {
    state.can = { canCreateMeeting: true, canDeleteMeeting: false, canEditMeetingTemplate: false }
    renderPage()
    expect(screen.getByText('Default agenda for new meetings')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit default agenda' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Show the default agenda'))
    expect(await within(screen.getByTestId('template-view')).findByRole('heading', { name: 'Agenda' })).toBeInTheDocument()
  })

  it('opens in a dialog only when asked, previews as it will read, and saves', async () => {
    state.can = { canCreateMeeting: true, canDeleteMeeting: true, canEditMeetingTemplate: true }
    renderPage()
    // No editor on the page itself.
    expect(screen.queryByLabelText('Default agenda')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit default agenda' }))
    const dialog = screen.getByRole('dialog')
    const box = within(dialog).getByLabelText('Default agenda')
    await userEvent.clear(box)
    await userEvent.type(box, '## Safety{enter}{enter}- helmets')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    expect(await within(dialog).findByRole('heading', { name: 'Safety' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save default agenda' }))
    await waitFor(() => expect(state.saved).toEqual(['## Safety\n\n- helmets']))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/Default agenda saved/)).toBeInTheDocument()
  })

  it('keeps what was typed after a failed save, and after closing the dialog, until it is discarded', async () => {
    state.can = { canCreateMeeting: true, canDeleteMeeting: true, canEditMeetingTemplate: true }
    state.saveError = new Error('network down')
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Edit default agenda' }))
    const box = within(screen.getByRole('dialog')).getByLabelText('Default agenda')
    await userEvent.type(box, 'my change')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save default agenda' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('network down')
    expect(within(screen.getByRole('dialog')).getByLabelText('Default agenda')).toHaveValue('## Agenda\n\n- my change')

    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.getByTestId('template-draft-kept')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit default agenda' }))
    expect(within(screen.getByRole('dialog')).getByLabelText('Default agenda')).toHaveValue('## Agenda\n\n- my change')

    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    expect(screen.queryByTestId('template-draft-kept')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit default agenda' }))
    expect(within(screen.getByRole('dialog')).getByLabelText('Default agenda')).toHaveValue('## Agenda\n\n- ')
    expect(state.saved).toEqual([])
  })
})

describe('calling and editing a meeting', () => {
  const admin = () => { state.can = { canCreateMeeting: true, canDeleteMeeting: true, canEditMeetingTemplate: false } }

  it('needs a name and a date, and an end after the start, before anything is sent', async () => {
    admin()
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'New meeting' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Add meeting' }))
    expect(dialog.getByText('Give the meeting a name.')).toBeInTheDocument()
    expect(dialog.getByText('A meeting needs a date.')).toBeInTheDocument()
    expect(dialog.getByLabelText('Name')).toHaveFocus()
    await user.type(dialog.getByLabelText('Name'), 'Weekly build')
    await user.type(dialog.getByLabelText('Date'), '2026-10-01')
    await user.type(dialog.getByLabelText('Starts (optional)'), '18:00')
    await user.type(dialog.getByLabelText('Ends (optional)'), '17:00')
    await user.click(dialog.getByRole('button', { name: 'Add meeting' }))
    expect(dialog.getByText('The end must be after the start.')).toBeInTheDocument()
    expect(state.created).toEqual([])
  })

  it('starts the agenda from the default agenda, previews it, and sends exactly what was typed', async () => {
    admin()
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'New meeting' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText('Agenda')).toHaveValue('## Agenda\n\n- ')
    await user.type(dialog.getByLabelText('Name'), '  Weekly build  ')
    await user.type(dialog.getByLabelText('Date'), '2026-10-01')
    await user.type(dialog.getByLabelText('Agenda'), 'tyres')
    await user.click(dialog.getAllByRole('button', { name: 'Preview' })[0])
    expect(await dialog.findByRole('heading', { name: 'Agenda' })).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Add meeting' }))
    await waitFor(() => expect(state.created).toHaveLength(1))
    expect(state.created[0]).toEqual({
      title: 'Weekly build', heldOn: '2026-10-01', startsAt: null, endsAt: null, location: null,
      agenda: '## Agenda\n\n- tyres', notes: null, attendees: null,
    })
    expect(screen.getByText('Meeting added.')).toBeInTheDocument()
  })

  it('keeps what was typed when the save is refused', async () => {
    admin()
    state.writeError = new Error("You don't have permission to call meetings.")
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'New meeting' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.type(dialog.getByLabelText('Name'), 'Weekly build')
    await user.type(dialog.getByLabelText('Date'), '2026-10-01')
    await user.click(dialog.getByRole('button', { name: 'Add meeting' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('permission')
    expect(dialog.getByLabelText('Name')).toHaveValue('Weekly build')
  })

  it('edits an existing meeting with its own values, and deletes only after confirming', async () => {
    admin()
    state.meetings = [meeting({ agenda: '## Old', notes: 'Decided things', attendees: 'Ada' })]
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Edit Weekly build' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText('Name')).toHaveValue('Weekly build')
    expect(dialog.getByLabelText('Starts (optional)')).toHaveValue('18:00')
    expect(dialog.getByLabelText('Minutes (optional)')).toHaveValue('Decided things')
    await user.clear(dialog.getByLabelText('Where (optional)'))
    await user.click(dialog.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(state.updated).toHaveLength(1))
    expect(state.updated[0]).toMatchObject({ id: 'm1', title: 'Weekly build', location: null, notes: 'Decided things' })

    await user.click(screen.getByRole('button', { name: 'Delete Weekly build' }))
    expect(state.deleted).toEqual([])
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete meeting' }))
    await waitFor(() => expect(state.deleted).toEqual(['m1']))
    expect(screen.getByText('Meeting deleted.')).toBeInTheDocument()
  })

  it('draws every element meeting notes use: sub-headings, numbered lists, code, quotes and emphasis', async () => {
    state.meetings = [meeting({ notes: '### Sub\n\n1. first\n2. second\n\n> quoted\n\n`code` and *soft* ~~gone~~\n\n---' })]
    renderPage()
    const notes = await screen.findByTestId('meeting-notes-m1')
    expect(await within(notes).findByRole('heading', { level: 5, name: 'Sub' })).toBeInTheDocument()
    expect(notes.querySelector('ol')?.children).toHaveLength(2)
    expect(notes.querySelector('blockquote')).toHaveTextContent('quoted')
    expect(notes.querySelector('code')).toHaveTextContent('code')
    expect(notes.querySelector('em')).toHaveTextContent('soft')
    expect(notes.querySelector('hr')).not.toBeNull()
  })
})

describe('formatting controls', () => {
  it('writes the Markdown a person would type: a heading, points and sub-points on the current line, bold around the selection', async () => {
    state.can = { canCreateMeeting: true, canDeleteMeeting: false, canEditMeetingTemplate: false }
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'New meeting' }))
    const dialog = within(screen.getByRole('dialog'))
    const minutes = dialog.getByLabelText('Minutes (optional)') as HTMLTextAreaElement
    const tools = within(dialog.getByRole('toolbar', { name: 'Format Minutes (optional)' }))
    // Each button puts the caret back a frame later, as in a browser.
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    await user.type(minutes, 'Safety')
    await user.click(tools.getByRole('button', { name: 'Heading' }))
    expect(minutes).toHaveValue('## Safety')
    await frame()
    await user.type(minutes, '{End}{enter}helmets')
    await frame()
    minutes.setSelectionRange(minutes.value.length, minutes.value.length)
    await user.click(tools.getByRole('button', { name: /Sub-point/ }))
    expect(minutes).toHaveValue('## Safety\n  - helmets')
    // A point replaces the sub-point marker instead of stacking another one.
    await frame()
    minutes.setSelectionRange(minutes.value.length, minutes.value.length)
    await user.click(tools.getByRole('button', { name: /• Point/ }))
    expect(minutes).toHaveValue('## Safety\n- helmets')
    await frame()
    minutes.setSelectionRange(12, 19)
    await user.click(tools.getByRole('button', { name: 'Bold' }))
    expect(minutes).toHaveValue('## Safety\n- **helmets**')
  })
})
