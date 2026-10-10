import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canEditContacts, type TaskActor } from '../auth/permissions.ts'
import type { ContactCategory, Contact } from '../data/useContacts.ts'
import Contacts from './Contacts.tsx'

const state = vi.hoisted(() => ({ actor: null as unknown, saveContact: vi.fn() }))

const category = (id: string, name: string): ContactCategory => ({
  id, name, description: null, created_by: null, created_at: '', updated_at: '',
})
const contact = (over: Partial<Contact>): Contact => ({
  id: 'c', category_id: 'admin', name: 'x', title: null, help: 'x', email: null, phone: null, website: null,
  created_by: null, created_at: '', updated_at: '', ...over,
})

vi.mock('../data/useTaskActor.ts', () => ({ useTaskActor: () => state.actor }))
vi.mock('../data/useContacts.ts', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false, error: null })
  return {
    useContactDirectory: () => ({
      isPending: false,
      error: null,
      data: {
        categories: [category('admin', 'Administration'), category('mech', 'Mechanical design')],
        contacts: [
          contact({ id: 'studieliv', category_id: 'admin', name: 'Studieliv', help: 'Student administration', website: 'studieliv.sdu.dk' }),
          contact({ id: 'andrei', category_id: 'mech', name: 'Andrei Popa', title: 'Lecturer', help: 'NX software design', email: 'andrei@sdu.dk' }),
          contact({ id: 'evil', category_id: 'mech', name: 'Evil', help: 'x', website: 'javascript:alert(1)' }),
        ],
      },
    }),
    useSaveCategory: mutation,
    useDeleteCategory: mutation,
    useDeleteContact: mutation,
    useSaveContact: () => ({ mutateAsync: state.saveContact, isPending: false, error: null }),
  }
})

const member: TaskActor = { id: 'm', status: 'active', isDeveloper: false, headOf: [] }
const head: TaskActor = { ...member, headOf: ['MECH'] }

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/contacts']}>
      <Contacts />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  state.actor = member
  state.saveContact.mockReset()
})

describe('Contacts', () => {
  it('lists people by category, with working ways to reach them, and no editing for a member', async () => {
    renderPage()
    const andrei = screen.getByTestId('contact-andrei')
    expect(within(andrei).getByText(/NX software design/)).toBeInTheDocument()
    expect(within(andrei).getByRole('link', { name: 'andrei@sdu.dk' })).toHaveAttribute('href', 'mailto:andrei@sdu.dk')
    expect(within(screen.getByTestId('contact-studieliv')).getByRole('link')).toHaveAttribute('href', 'https://studieliv.sdu.dk')
    // A stored non-http address can never become a script link.
    expect(within(screen.getByTestId('contact-evil')).getByRole('link').getAttribute('href')).toMatch(/^https:\/\//)
    expect(screen.queryByRole('button', { name: /new category/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^edit/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Administration/ }))
    expect(screen.getByTestId('contact-studieliv')).toBeInTheDocument()
    expect(screen.queryByTestId('contact-andrei')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^All/ }))
    await userEvent.type(screen.getByLabelText('Search'), 'nx')
    expect(await screen.findByTestId('contact-andrei')).toBeInTheDocument()
    expect(screen.queryByTestId('contact-studieliv')).not.toBeInTheDocument()
  })

  it('lets a department Head add a contact, but only with a way to reach them', async () => {
    state.actor = head
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Add contact to Mechanical design' }))
    await userEvent.type(screen.getByLabelText('Name'), 'New person')
    await userEvent.type(screen.getByLabelText('Can help with'), 'Welding')
    await userEvent.click(screen.getByRole('button', { name: 'Add contact' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/email, a phone number or a website/i)
    expect(state.saveContact).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('Email'), 'new@sdu.dk')
    await userEvent.click(screen.getByRole('button', { name: 'Add contact' }))
    expect(state.saveContact).toHaveBeenCalledWith(
      expect.objectContaining({ category_id: 'mech', name: 'New person', help: 'Welding', email: 'new@sdu.dk', phone: null, website: null }),
    )
  })
})

describe('canEditContacts (mirror of can_edit_contacts())', () => {
  it('allows active Heads, the President / Vice President and Developers only', () => {
    expect(canEditContacts(null)).toBe(false)
    expect(canEditContacts(member)).toBe(false)
    expect(canEditContacts(head)).toBe(true)
    expect(canEditContacts({ ...head, status: 'alumni' })).toBe(false)
    expect(canEditContacts({ ...member, isGovernance: true })).toBe(true)
    expect(canEditContacts({ ...member, isDeveloper: true })).toBe(true)
  })
})
