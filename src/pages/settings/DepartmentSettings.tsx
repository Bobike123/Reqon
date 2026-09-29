import { useEffect, useId, useRef, useState } from 'react'
import { useAuth } from '../../auth/context.ts'
import { useMembers } from '../../data/useMembers.ts'
import {
  useArchiveDepartment,
  useCreateDepartment,
  useRestoreDepartment,
  useReorderDepartments,
  useSubteams,
  useUpdateSubteam,
} from '../../data/useSubteams.ts'
import { DEPARTMENT_CAP, activeCount, isActive, type Department } from '../../departments/types.ts'
import { buttonDanger, buttonPrimary, buttonQuiet, buttonSecondary } from '../../ui/buttons.ts'
import { mergeSearchParams } from '../../lib/searchParams.ts'
import { ActionError, ErrorState } from '../../ui/states.tsx'
import { useUrlParams } from '../../lib/useUrlParams.ts'

// Department lifecycle: create, rename, describe, appoint/change Head,
// reorder, archive, restore. Admin-only (President/Vice President/
// Developer — can_manage_departments()), so the route shell never renders
// this section for anyone else (pages/Settings.tsx). The database enforces
// every rule here again; nothing in this file is the authorization
// boundary.
export function DepartmentSettings() {
  const subteams = useSubteams()
  const members = useMembers()
  const auth = useAuth()
  const create = useCreateDepartment()
  const archive = useArchiveDepartment()
  const restore = useRestoreDepartment()
  const reorder = useReorderDepartments()
  const [archiving, setArchiving] = useState<Department | null>(null)
  const [archiveReason, setArchiveReason] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')
  const [saved, setSaved] = useState<{ key: string; text: string } | null>(null)
  // The department being edited lives in the address (?edit=department:KEY),
  // so a contextual "Edit" link elsewhere opens exactly this editor.
  const [params, setParams] = useUrlParams()
  const editParam = params.get('edit')
  const editingKey = editParam?.startsWith('department:') ? editParam.slice('department:'.length) : null
  const openEdit = (key: string) => {
    setSaved(null)
    setParams((current) => mergeSearchParams(current, { edit: `department:${key}` }), { replace: true })
  }
  const closeEdit = () => setParams((current) => mergeSearchParams(current, { edit: null }), { replace: true })

  const readError = subteams.error ?? members.error
  const anyActionError = create.error ?? archive.error ?? restore.error ?? reorder.error ?? null

  if (readError) {
    return (
      <ErrorState
        title="Could not load departments"
        error={readError}
        onRetry={() => {
          void subteams.refetch()
          void members.refetch()
        }}
      />
    )
  }

  const all = subteams.data ?? []
  const active = all.filter(isActive).sort((a, b) => a.sort_order - b.sort_order)
  const archived = all.filter((d) => !isActive(d))
  const activeMembers = (members.data ?? []).filter((m) => m.status === 'active')
  const memberName = (id: string | null) => (members.data ?? []).find((m) => m.id === id)?.full_name
  const active_n = activeCount(all)
  const atCap = active_n >= DEPARTMENT_CAP

  function move(key: string, direction: -1 | 1) {
    const order = active.map((d) => d.key)
    const i = order.indexOf(key)
    const j = i + direction
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    reorder.mutate(order)
  }

  return (
    <>
      <ActionError error={anyActionError} className="mb-2" />

      <p role="status" className="mb-3 text-xs text-slate-600">
        <span className={atCap ? 'font-semibold text-amber-800' : ''}>
          {active_n} active / {DEPARTMENT_CAP}
        </span>
        {atCap && ' — archive one before creating or restoring another.'}
      </p>

      {editingKey && subteams.data !== undefined && !active.some((d) => d.key === editingKey) && (
        <p role="status" className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950" data-testid="department-edit-missing">
          {archived.some((d) => d.key === editingKey)
            ? `${editingKey} is archived. Restore it below to edit it.`
            : `There is no department ${editingKey}.`}
        </p>
      )}

      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {active.map((d, i) => (
          <li key={d.key} className="group px-3 py-2" data-testid={`department-row-${d.key}`}>
            {editingKey === d.key ? (
              <DepartmentEditor
                department={d}
                activeMembers={activeMembers}
                memberName={memberName}
                onDone={(note) => {
                  setSaved(note ? { key: d.key, text: note } : null)
                  closeEdit()
                }}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-500">{d.key}</span>
                  <span className="text-sm font-medium text-slate-900">{d.name}</span>
                  {d.is_parked && (
                    <span
                      className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600"
                      title="Parked: these rules only bite at the Final Event. Independent of archiving."
                    >
                      Parked
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    {/* Shown on hover and keyboard focus; always on touch
                        screens and phones, where there is no hover. Opening
                        the editor only ever happens on activation. */}
                    <button
                      type="button"
                      onClick={() => openEdit(d.key)}
                      aria-label={`Edit ${d.name}`}
                      className={`${buttonSecondary} text-xs transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 pointer-coarse:opacity-100`}
                      data-testid={`department-edit-${d.key}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => move(d.key, -1)}
                      disabled={i === 0 || reorder.isPending}
                      aria-label={`Move ${d.name} up`}
                      className={buttonQuiet}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(d.key, 1)}
                      disabled={i === active.length - 1 || reorder.isPending}
                      aria-label={`Move ${d.name} down`}
                      className={buttonQuiet}
                    >
                      ↓
                    </button>
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-700" data-testid={`department-head-${d.key}`}>
                  <span className="text-slate-500">Head of Department: </span>
                  {d.lead_id
                    ? activeMembers.some((m) => m.id === d.lead_id)
                      ? memberName(d.lead_id)
                      : `${memberName(d.lead_id) ?? 'Unknown member'} (no longer active — reassign)`
                    : 'No Head appointed'}
                </p>
                <p className="mt-0.5 text-xs text-slate-600">{d.description || <span className="text-slate-500">No description.</span>}</p>
                {saved?.key === d.key && (
                  <p role="status" className="mt-1 text-xs font-medium text-emerald-800" data-testid={`department-saved-${d.key}`}>
                    {saved.text}
                  </p>
                )}
                <div className="mt-1.5">
                  <button type="button" onClick={() => { setArchiving(d); setArchiveReason('') }} className={buttonQuiet}>
                    Archive…
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-slate-300 p-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!newKey.trim() || !newName.trim() || atCap) return
          create.mutate(
            { key: newKey.trim().toUpperCase(), name: newName.trim() },
            { onSuccess: () => { setNewKey(''); setNewName('') } },
          )
        }}
      >
        <div>
          <label className="block text-xs font-medium text-slate-700" htmlFor="new-dept-key">Key</label>
          <input
            id="new-dept-key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="e.g. SWDATA"
            disabled={atCap}
            className="min-h-11 w-32 rounded border border-slate-300 px-2 py-1 text-sm uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-50 sm:min-h-0"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-700" htmlFor="new-dept-name">Name</label>
          <input
            id="new-dept-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Software & Data Collection"
            disabled={atCap}
            className="min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-50 sm:min-h-0"
          />
        </div>
        <button
          type="submit"
          disabled={create.isPending || atCap || !newKey.trim() || !newName.trim()}
          className={buttonPrimary}
        >
          {create.isPending ? 'Creating…' : 'New department'}
        </button>
      </form>

      {archived.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            Archived ({archived.length})
          </summary>
          <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-slate-50">
            {archived.map((d) => (
              <li key={d.key} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid={`department-archived-${d.key}`}>
                <span className="font-mono text-xs text-slate-500">{d.key}</span>
                <span className="text-sm text-slate-700">{d.name}</span>
                {d.archive_reason && <span className="text-xs text-slate-500">— {d.archive_reason}</span>}
                <button
                  type="button"
                  onClick={() => restore.mutate({ key: d.key })}
                  disabled={restore.isPending || atCap}
                  className={`${buttonSecondary} ml-auto`}
                  title={atCap ? 'At the 10-active limit — archive one first' : undefined}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <ArchiveConfirm
        department={archiving}
        reason={archiveReason}
        onReasonChange={setArchiveReason}
        pending={archive.isPending}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          if (!archiving || !archiveReason.trim()) return
          archive.mutate(
            { key: archiving.key, reason: archiveReason.trim() },
            { onSuccess: () => setArchiving(null) },
          )
        }}
        signedInAs={auth.status === 'member' ? auth.member.full_name : ''}
      />
    </>
  )
}

type Member = { id: string; full_name: string }

// One department's editor: every field the department_update policy lets an
// administrator change, saved together by an explicit Save — never on blur.
// The key is shown, never editable (1,146 clauses join on it). The result says
// what was saved, that nothing needed saving, or the refusal; a refusal keeps
// what was typed.
function DepartmentEditor({
  department,
  activeMembers,
  memberName,
  onDone,
}: {
  department: Department
  activeMembers: Member[]
  memberName: (id: string | null) => string | undefined
  onDone: (note: string | null) => void
}) {
  const update = useUpdateSubteam()
  const id = useId()
  const [name, setName] = useState(department.name)
  const [description, setDescription] = useState(department.description ?? '')
  const [leadId, setLeadId] = useState(department.lead_id ?? '')
  const [parked, setParked] = useState(department.is_parked)
  const [note, setNote] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    boxRef.current?.scrollIntoView?.({ block: 'center' })
    nameRef.current?.focus()
  }, [])
  const staleHead = department.lead_id !== null && !activeMembers.some((m) => m.id === department.lead_id)

  async function save() {
    setNote(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setNote('A department needs a name.')
      nameRef.current?.focus()
      return
    }
    const edit: Parameters<typeof update.mutateAsync>[0] = { key: department.key }
    const changed: string[] = []
    if (trimmed !== department.name) {
      edit.name = trimmed
      changed.push('name')
    }
    const nextDescription = description.trim() || null
    if (nextDescription !== (department.description ?? null)) {
      edit.description = nextDescription
      changed.push('description')
    }
    const nextLead = leadId || null
    if (nextLead !== department.lead_id) {
      edit.leadId = nextLead
      changed.push('Head')
    }
    if (parked !== department.is_parked) {
      edit.isParked = parked
      changed.push(parked ? 'parked' : 'no longer parked')
    }
    if (changed.length === 0) {
      setNote('Nothing to save — no field was changed.')
      return
    }
    try {
      await update.mutateAsync(edit)
      onDone(`Saved: ${changed.join(', ')}.`)
    } catch {
      // Shown below; what was typed stays.
    }
  }

  const field =
    'mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'
  return (
    <div ref={boxRef} role="group" aria-labelledby={`${id}-title`} data-testid={`department-editor-${department.key}`}>
      <p id={`${id}-title`} className="text-sm font-medium text-slate-900">
        Edit <span className="font-mono text-xs text-slate-500">{department.key}</span> {department.name}
      </p>
      <fieldset disabled={update.isPending} className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-slate-700" htmlFor={`dept-name-${department.key}`}>
            Name for {department.key}
          </label>
          <input ref={nameRef} id={`dept-name-${department.key}`} value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700" htmlFor={`dept-head-${department.key}`}>
            Head of Department for {department.key}
          </label>
          <select id={`dept-head-${department.key}`} value={leadId} onChange={(e) => setLeadId(e.target.value)} className={`${field} bg-white`}>
            <option value="">No Head appointed</option>
            {activeMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
            {/* A stale Head (retired) stays visible and selected so nobody
                mistakes "no Head" for "used to have one" — but it is not
                offered as a new choice (ADR-0003). */}
            {staleHead && (
              <option value={department.lead_id ?? ''} disabled>
                {memberName(department.lead_id) ?? 'Unknown member'} (no longer active — reassign)
              </option>
            )}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-slate-700" htmlFor={`dept-desc-${department.key}`}>
            Description for {department.key}
          </label>
          <input
            id={`dept-desc-${department.key}`}
            value={description}
            placeholder="What this department covers"
            onChange={(e) => setDescription(e.target.value)}
            className={field}
          />
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-800 sm:col-span-2">
          <input type="checkbox" checked={parked} onChange={(e) => setParked(e.target.checked)} className="mt-0.5 h-5 w-5 accent-slate-900" />
          <span>
            Parked
            <span className="block text-xs text-slate-600">
              Its rules only bite at the Final Event. It stays an active department and keeps its tasks — this is not archiving.
            </span>
          </span>
        </label>
      </fieldset>
      <ActionError error={update.error} className="mt-2" />
      {note && (
        <p role="status" className="mt-2 text-xs text-slate-700" data-testid={`department-note-${department.key}`}>
          {note}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={() => onDone(null)} disabled={update.isPending} className={buttonSecondary}>
          Cancel
        </button>
        <button type="button" onClick={() => void save()} disabled={update.isPending} className={buttonPrimary}>
          {update.isPending ? 'Saving…' : 'Save department'}
        </button>
      </div>
    </div>
  )
}

// A lightweight inline confirm rather than a full Dialog: archiving asks for
// exactly one required piece of information (why), and the database's own
// refusal (stranded work, per guard_department_archive) already shows
// through ActionError above if this is not actually safe to do.
function ArchiveConfirm({
  department,
  reason,
  onReasonChange,
  pending,
  onCancel,
  onConfirm,
  signedInAs,
}: {
  department: Department | null
  reason: string
  onReasonChange: (value: string) => void
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
  signedInAs: string
}) {
  const id = useId()
  if (!department) return null
  return (
    <div
      role="alertdialog"
      aria-labelledby={id}
      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3"
    >
      <p id={id} className="text-sm font-medium text-amber-950">
        Archive {department.name}?
      </p>
      <p className="mt-1 text-xs text-amber-900">
        It leaves the active list and the 10-department cap. Nothing is deleted — restore it any time
        from Archived below. Refused while it still has active tasks.
      </p>
      <label className="mt-2 block text-xs font-medium text-amber-950" htmlFor={`${id}-reason`}>
        Reason (kept in the audit trail as {signedInAs || 'you'})
      </label>
      <input
        id={`${id}-reason`}
        value={reason}
        onChange={(e) => onReasonChange(e.target.value)}
        disabled={pending}
        className="mt-1 min-h-11 w-full rounded border border-amber-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 sm:min-h-0"
      />
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} disabled={pending} className={buttonSecondary}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={pending || !reason.trim()} className={buttonDanger}>
          {pending ? 'Archiving…' : 'Archive'}
        </button>
      </div>
    </div>
  )
}
