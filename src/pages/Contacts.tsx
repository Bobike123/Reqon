import { useDeferredValue, useId, useMemo, useState, type FormEvent } from 'react'
import { canEditContacts } from '../auth/permissions.ts'
import {
  useContactDirectory,
  useDeleteCategory,
  useDeleteContact,
  useSaveCategory,
  useSaveContact,
  type Contact,
  type ContactCategory,
} from '../data/useContacts.ts'
import { useTaskActor } from '../data/useTaskActor.ts'
import { mergeSearchParams } from '../lib/searchParams.ts'
import { useUrlParams } from '../lib/useUrlParams.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { PageHeader } from '../ui/PageHeader.tsx'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { pageMain } from '../ui/layout.ts'
import { ActionError, EmptyState, ErrorState, LoadingState } from '../ui/states.tsx'

// Who can help with what, and how to reach them: a directory grouped into
// categories (Administration, Mechanical design, …). Every member reads it;
// department Heads, the President and the Vice President keep it up to date
// (can_edit_contacts(), 20260136000000 — the database checks every write).

// 16px on a phone, so iOS does not zoom the page when a field is tapped.
const input =
  'mt-1 block min-h-11 w-full rounded border border-slate-300 bg-white px-2.5 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-9 sm:text-sm'
const label = 'block text-sm font-medium text-slate-900'
const chip = (active: boolean) =>
  `inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-8 ${
    active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
  }`

// Only http(s) links leave the page: anything else typed in is treated as a
// bare address, so a stored "javascript:" can never run.
const websiteHref = (website: string) => (/^https?:\/\//i.test(website) ? website : `https://${website}`)

type Editing =
  | { kind: 'category'; category: ContactCategory | null }
  | { kind: 'contact'; contact: Contact | null; categoryId: string }
  | { kind: 'delete-category'; category: ContactCategory; count: number }
  | { kind: 'delete-contact'; contact: Contact }

export default function Contacts() {
  const directory = useContactDirectory()
  const canEdit = canEditContacts(useTaskActor())
  const [params, setParams] = useUrlParams()
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim().toLowerCase())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [message, setMessage] = useState('')

  const categories = useMemo(() => directory.data?.categories ?? [], [directory.data])
  const contacts = useMemo(() => directory.data?.contacts ?? [], [directory.data])
  const rawCategory = params.get('category')
  const selected = categories.some((c) => c.id === rawCategory) ? rawCategory : null
  const choose = (id: string | null) => setParams((current) => mergeSearchParams(current, { category: id }), { replace: true })

  const byCategory = useMemo(() => {
    const map = new Map<string, Contact[]>()
    for (const contact of contacts) map.set(contact.category_id, [...(map.get(contact.category_id) ?? []), contact])
    return map
  }, [contacts])

  const matches = (c: Contact) =>
    query === '' || [c.name, c.title, c.help, c.email].some((field) => field?.toLowerCase().includes(query))
  const shown = categories
    .filter((category) => selected === null || category.id === selected)
    .map((category) => ({ category, people: (byCategory.get(category.id) ?? []).filter(matches) }))
    // Searching hides categories with no match; browsing keeps empty ones, so an editor can fill them.
    .filter(({ people }) => query === '' || people.length > 0)

  const done = (text: string) => {
    setEditing(null)
    setMessage(text)
  }

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader
        title="Contacts"
        description="Who can help with what, and how to reach them. Pick an area to see the people who know it."
        tutorialId="contacts-overview"
      >
        <p className="mt-1 text-sm text-slate-700">
          {canEdit
            ? 'You can add categories and contacts, and edit or remove any of them.'
            : 'Department Heads, the President and the Vice President keep this list up to date. Ask one of them to add someone.'}
        </p>
      </PageHeader>

      {directory.error ? (
        <ErrorState title="Could not load the contacts" error={directory.error} onRetry={() => void directory.refetch()} />
      ) : directory.isPending ? (
        <LoadingState label="Loading contacts…" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-60">
              <label htmlFor="contacts-search" className="block text-xs font-medium text-slate-600">
                Search
              </label>
              <input
                id="contacts-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, skill or software…"
                className={input}
              />
            </div>
            {canEdit && (
              <button type="button" className={buttonPrimary} onClick={() => { setMessage(''); setEditing({ kind: 'category', category: null }) }}>
                New category
              </button>
            )}
          </div>

          {categories.length > 0 && (
            <nav aria-label="Categories" className="mb-4">
              <ul className="flex flex-wrap gap-1.5">
                <li>
                  <button type="button" aria-pressed={selected === null} onClick={() => choose(null)} className={chip(selected === null)}>
                    All <span className="opacity-70">({contacts.length})</span>
                  </button>
                </li>
                {categories.map((category) => (
                  <li key={category.id}>
                    <button type="button" aria-pressed={selected === category.id} onClick={() => choose(category.id)} className={chip(selected === category.id)}>
                      {category.name} <span className="opacity-70">({byCategory.get(category.id)?.length ?? 0})</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <p role="status" className="mb-2 min-h-5 text-sm text-emerald-800">
            {message}
          </p>

          {categories.length === 0 ? (
            <EmptyState title="No contacts yet">
              {canEdit
                ? 'Start with “New category” — for example Administration or Mechanical design — then add the people in it.'
                : 'Once a department Head adds the first category, the people who can help will be listed here.'}
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState title="Nobody matches">Try another word, or pick “All”.</EmptyState>
          ) : (
            <div className="space-y-6">
              {shown.map(({ category, people }) => (
                <section key={category.id} aria-labelledby={`category-${category.id}`} data-testid={`category-${category.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 pb-1.5">
                    <div className="min-w-0">
                      <h2 id={`category-${category.id}`} className="text-base font-semibold text-slate-900">
                        {category.name}
                      </h2>
                      {category.description && <p className="text-sm text-slate-600">{category.description}</p>}
                    </div>
                    {canEdit && (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" aria-label={`Add contact to ${category.name}`} className={buttonSecondary} onClick={() => { setMessage(''); setEditing({ kind: 'contact', contact: null, categoryId: category.id }) }}>
                          Add contact
                        </button>
                        <button type="button" aria-label={`Edit ${category.name}`} className={buttonSecondary} onClick={() => { setMessage(''); setEditing({ kind: 'category', category }) }}>
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${category.name}`}
                          className={buttonSecondary}
                          onClick={() => { setMessage(''); setEditing({ kind: 'delete-category', category, count: byCategory.get(category.id)?.length ?? 0 }) }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                  {people.length === 0 ? (
                    <p className="py-3 text-sm text-slate-600">No one in this category yet.</p>
                  ) : (
                    <ul className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {people.map((contact) => (
                        <ContactCard
                          key={contact.id}
                          contact={contact}
                          canEdit={canEdit}
                          onEdit={() => { setMessage(''); setEditing({ kind: 'contact', contact, categoryId: contact.category_id }) }}
                          onDelete={() => { setMessage(''); setEditing({ kind: 'delete-contact', contact }) }}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <Dialog open={editing?.kind === 'category'} onClose={() => setEditing(null)} labelledBy="category-dialog-title">
        {editing?.kind === 'category' && <CategoryForm category={editing.category} onCancel={() => setEditing(null)} onSaved={done} />}
      </Dialog>
      <Dialog open={editing?.kind === 'contact'} onClose={() => setEditing(null)} labelledBy="contact-dialog-title">
        {editing?.kind === 'contact' && (
          <ContactForm contact={editing.contact} categoryId={editing.categoryId} categories={categories} onCancel={() => setEditing(null)} onSaved={done} />
        )}
      </Dialog>
      <Dialog open={editing?.kind === 'delete-category' || editing?.kind === 'delete-contact'} onClose={() => setEditing(null)} labelledBy="delete-dialog-title">
        {editing?.kind === 'delete-category' && (
          <ConfirmDelete
            what={`the category “${editing.category.name}”`}
            detail={
              editing.count > 0
                ? `Its ${editing.count} contact${editing.count === 1 ? '' : 's'} will be deleted with it. This cannot be undone.`
                : 'It has no contacts. This cannot be undone.'
            }
            id={editing.category.id}
            kind="category"
            onCancel={() => setEditing(null)}
            onDeleted={() => {
              if (selected === editing.category.id) choose(null)
              done('Category deleted.')
            }}
          />
        )}
        {editing?.kind === 'delete-contact' && (
          <ConfirmDelete
            what={editing.contact.name}
            detail="They will be removed from the list for everyone. This cannot be undone."
            id={editing.contact.id}
            kind="contact"
            onCancel={() => setEditing(null)}
            onDeleted={() => done('Contact deleted.')}
          />
        )}
      </Dialog>
    </main>
  )
}

function ContactCard({ contact, canEdit, onEdit, onDelete }: { contact: Contact; canEdit: boolean; onEdit: () => void; onDelete: () => void }) {
  const link = 'inline-flex min-h-11 items-center break-all text-slate-900 underline decoration-slate-400 underline-offset-2 hover:decoration-slate-900 sm:min-h-0'
  return (
    <li className="flex flex-col rounded-lg border border-slate-200 bg-white p-3" data-testid={`contact-${contact.id}`}>
      <p className="font-medium text-slate-900">
        {contact.name}
        {contact.title && <span className="font-normal text-slate-600"> · {contact.title}</span>}
      </p>
      <p className="mt-1 text-sm whitespace-pre-line text-slate-700">
        <span className="font-medium text-slate-900">Can help with: </span>
        {contact.help}
      </p>
      <ul className="mt-2 space-y-0.5 text-sm" aria-label={`How to contact ${contact.name}`}>
        {contact.email && (
          <li>
            <a href={`mailto:${contact.email}`} className={link}>{contact.email}</a>
          </li>
        )}
        {contact.phone && (
          <li>
            <a href={`tel:${contact.phone.replace(/[^0-9+]/g, '')}`} className={link}>{contact.phone}</a>
          </li>
        )}
        {contact.website && (
          <li>
            <a href={websiteHref(contact.website)} target="_blank" rel="noopener noreferrer" className={link}>
              {contact.website.replace(/^https?:\/\//i, '')}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        )}
      </ul>
      {canEdit && (
        <div className="mt-auto flex justify-end gap-2 pt-2">
          <button type="button" aria-label={`Edit ${contact.name}`} className={buttonSecondary} onClick={onEdit}>
            Edit
          </button>
          <button type="button" aria-label={`Delete ${contact.name}`} className={buttonSecondary} onClick={onDelete}>
            Delete
          </button>
        </div>
      )}
    </li>
  )
}

const blankToNull = (value: FormDataEntryValue | null) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

function CategoryForm({ category, onCancel, onSaved }: { category: ContactCategory | null; onCancel: () => void; onSaved: (message: string) => void }) {
  const save = useSaveCategory()
  const id = useId()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      await save.mutateAsync({ id: category?.id, name: blankToNull(form.get('name')) ?? '', description: blankToNull(form.get('description')) })
      onSaved(category ? 'Category saved.' : 'Category added.')
    } catch {
      // Shown below.
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2 id="category-dialog-title" className="text-base font-semibold text-slate-900">
        {category ? 'Edit category' : 'New category'}
      </h2>
      <fieldset disabled={save.isPending} className="mt-3 space-y-3">
        <div>
          <label htmlFor={`${id}-name`} className={label}>Name</label>
          <input id={`${id}-name`} name="name" required maxLength={80} defaultValue={category?.name ?? ''} placeholder="Mechanical design" className={input} />
        </div>
        <div>
          <label htmlFor={`${id}-description`} className={label}>Description <span className="font-normal text-slate-500">(optional)</span></label>
          <input id={`${id}-description`} name="description" maxLength={300} defaultValue={category?.description ?? ''} placeholder="CAD, NX, manufacturing drawings" className={input} />
        </div>
      </fieldset>
      <ActionError error={save.error} className="mt-3" />
      <FormButtons busy={save.isPending} onCancel={onCancel} submit={category ? 'Save category' : 'Add category'} />
    </form>
  )
}

function ContactForm({
  contact,
  categoryId,
  categories,
  onCancel,
  onSaved,
}: {
  contact: Contact | null
  categoryId: string
  categories: readonly ContactCategory[]
  onCancel: () => void
  onSaved: (message: string) => void
}) {
  const save = useSaveContact()
  const id = useId()
  const [missingWay, setMissingWay] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = blankToNull(form.get('email'))
    const phone = blankToNull(form.get('phone'))
    const website = blankToNull(form.get('website'))
    // contacts_reachable: a contact nobody can reach is no use.
    if (!email && !phone && !website) {
      setMissingWay(true)
      return
    }
    setMissingWay(false)
    try {
      await save.mutateAsync({
        id: contact?.id,
        category_id: String(form.get('category')),
        name: blankToNull(form.get('name')) ?? '',
        title: blankToNull(form.get('title')),
        help: blankToNull(form.get('help')) ?? '',
        email,
        phone,
        website,
      })
      onSaved(contact ? 'Contact saved.' : 'Contact added.')
    } catch {
      // Shown below.
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2 id="contact-dialog-title" className="text-base font-semibold text-slate-900">
        {contact ? 'Edit contact' : 'Add contact'}
      </h2>
      <fieldset disabled={save.isPending} className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-name`} className={label}>Name</label>
          <input id={`${id}-name`} name="name" required maxLength={120} defaultValue={contact?.name ?? ''} placeholder="A person or an office" className={input} />
        </div>
        <div>
          <label htmlFor={`${id}-title`} className={label}>Role <span className="font-normal text-slate-500">(optional)</span></label>
          <input id={`${id}-title`} name="title" maxLength={120} defaultValue={contact?.title ?? ''} placeholder="Lecturer" className={input} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-help`} className={label}>Can help with</label>
          <textarea
            id={`${id}-help`}
            name="help"
            required
            maxLength={1000}
            rows={3}
            defaultValue={contact?.help ?? ''}
            placeholder="NX software design, industry contacts in mechatronics"
            className={`${input} py-2`}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-category`} className={label}>Category</label>
          <select id={`${id}-category`} name="category" defaultValue={categoryId} className={input}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <p id={`${id}-ways`} className="text-sm text-slate-700 sm:col-span-2">How to contact them — at least one:</p>
        <div>
          <label htmlFor={`${id}-email`} className={label}>Email</label>
          <input id={`${id}-email`} name="email" type="email" maxLength={254} defaultValue={contact?.email ?? ''} aria-describedby={`${id}-ways`} className={input} />
        </div>
        <div>
          <label htmlFor={`${id}-phone`} className={label}>Phone</label>
          <input
            id={`${id}-phone`}
            name="phone"
            type="tel"
            defaultValue={contact?.phone ?? ''}
            aria-describedby={`${id}-ways`}
            className={input}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-website`} className={label}>Website</label>
          <input
            id={`${id}-website`}
            name="website"
            maxLength={300}
            pattern="\S+"
            title="A web address without spaces"
            defaultValue={contact?.website ?? ''}
            placeholder="studieliv.sdu.dk"
            aria-describedby={`${id}-ways`}
            className={input}
          />
        </div>
      </fieldset>
      {missingWay && (
        <p role="alert" className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Add an email, a phone number or a website, so people can reach them.
        </p>
      )}
      <ActionError error={save.error} className="mt-3" />
      <FormButtons busy={save.isPending} onCancel={onCancel} submit={contact ? 'Save contact' : 'Add contact'} />
    </form>
  )
}

function ConfirmDelete({
  what,
  detail,
  id,
  kind,
  onCancel,
  onDeleted,
}: {
  what: string
  detail: string
  id: string
  kind: 'category' | 'contact'
  onCancel: () => void
  onDeleted: () => void
}) {
  const deleteCategory = useDeleteCategory()
  const deleteContact = useDeleteContact()
  const remove = kind === 'category' ? deleteCategory : deleteContact
  async function confirm() {
    try {
      await remove.mutateAsync(id)
      onDeleted()
    } catch {
      // Shown below.
    }
  }
  return (
    <div>
      <h2 id="delete-dialog-title" className="text-base font-semibold text-balance text-slate-900">
        Delete {what}?
      </h2>
      <p className="mt-2 text-sm text-slate-700">{detail}</p>
      <ActionError error={remove.error} className="mt-3" />
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={buttonSecondary} disabled={remove.isPending} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={buttonDanger} disabled={remove.isPending} onClick={() => void confirm()}>
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  )
}

function FormButtons({ busy, onCancel, submit }: { busy: boolean; onCancel: () => void; submit: string }) {
  return (
    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
      <button type="button" className={buttonSecondary} disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className={buttonPrimary} disabled={busy}>
        {busy ? 'Saving…' : submit}
      </button>
    </div>
  )
}
