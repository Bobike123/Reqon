import { useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useClauses } from '../../data/useClauses.ts'
import { useArchiveTask, useLinkTaskRequirement, useUnlinkTaskRequirement, useUpdateTask, type Task, type TaskEdit } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { buildRequirementOptions } from '../../proposals/requirementOptions.ts'
import { RequirementPicker } from '../../proposals/RequirementPicker.tsx'
import { completionLabel } from '../../tasks/lifecycle.ts'
import { TASK_PRIORITIES, TASK_PRIORITY_LABEL } from '../../tasks/priority.ts'
import type { TaskPriority } from '../../tasks/types.ts'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../../ui/buttons.ts'
import { ActionError } from '../../ui/states.tsx'
import { planTaskEdit, type EditPlan } from './taskEditPlan.ts'

export type TaskPermissions = { canEdit: boolean; canReassign: boolean; canArchive: boolean }

const FIELD =
  'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'
const LABEL = 'block text-xs font-medium text-slate-700'
const SECTION_HEADING = 'text-[11px] font-semibold tracking-wide text-slate-500 uppercase'

type Props = {
  task: Task
  perms: TaskPermissions
  owners: { id: string; name: string }[]
  milestones: { value: string; label: string }[]
  requirementKeys: string[]
  source: { id: string; title: string } | null
}

type Result = { kind: 'saved'; what: string } | { kind: 'nothing' } | null

// What opens under a card's "Details": the description, the blocker (kept apart
// from the description), the work this task is linked to, where it came from,
// and the ONE task editor — for exactly the fields ADR-0003 lets this person
// change. Owner, department, season, provenance and archive fields are never
// part of a generic edit. Someone who may not edit sees the same facts
// read-only, with the reason. Mounted only while open.
export function TaskDetails(props: Props) {
  const { task, perms } = props
  const update = useUpdateTask()
  const link = useLinkTaskRequirement()
  const unlink = useUnlinkTaskRequirement()
  const archive = useArchiveTask()
  const clauses = useClauses()
  const options = useMemo(() => buildRequirementOptions(clauses.data ?? []), [clauses.data])
  const printedRef = useMemo(() => new Map((clauses.data ?? []).map((c) => [c.clause_key, c.printed_ref])), [clauses.data])
  const uid = useId()
  const fid = (n: string) => `${uid}-${n}`

  const [title, setTitle] = useState(task.title)
  const [detail, setDetail] = useState(task.detail ?? '')
  const [start, setStart] = useState(task.starts_on ?? '')
  const [due, setDue] = useState(task.due_date ?? '')
  const [priority, setPriority] = useState<TaskPriority>(task.priority)
  const [milestone, setMilestone] = useState(task.milestone_key ?? '')
  const [owner, setOwner] = useState(task.owner_id ?? '')
  const [keys, setKeys] = useState<string[]>(props.requirementKeys)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const working = useRef(false)

  // Someone else changed the task while this editor was open: keep the typed
  // values, say so, and let the person choose to take the server's. Derived while
  // rendering (no effect): the baseline is the version this editor started from,
  // and our OWN save advances it when its result arrives.
  const [baseline, setBaseline] = useState(task.updated_at)
  const [selfSave, setSelfSave] = useState(false)
  if (task.updated_at !== baseline && selfSave) {
    setBaseline(task.updated_at)
    setSelfSave(false)
  }
  const changedElsewhere = task.updated_at !== baseline && !selfSave

  // Permission changed under an open editor (owner or Head changed).
  const [seenCanEdit, setSeenCanEdit] = useState(perms.canEdit)
  const [lostAccess, setLostAccess] = useState(false)
  if (seenCanEdit !== perms.canEdit) {
    setSeenCanEdit(perms.canEdit)
    setLostAccess(seenCanEdit && !perms.canEdit)
  }

  const dirtyKeys = keys.length !== props.requirementKeys.length || keys.some((k) => !props.requirementKeys.includes(k))

  const takeServerValues = () => {
    setTitle(task.title)
    setDetail(task.detail ?? '')
    setStart(task.starts_on ?? '')
    setDue(task.due_date ?? '')
    setPriority(task.priority)
    setMilestone(task.milestone_key ?? '')
    setOwner(task.owner_id ?? '')
    setBaseline(task.updated_at)
    setResult(null)
    setError(null)
  }

  async function run(work: () => Promise<void>) {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e : new Error('That did not work.'))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const save = () =>
    run(async () => {
      const plan: EditPlan = planTaskEdit(task, { title, detail, start, due, priority, milestone, owner }, perms.canReassign)
      if (plan.kind === 'invalid') throw new Error(plan.reason)
      const toAdd = keys.filter((k) => !props.requirementKeys.includes(k))
      const toRemove = props.requirementKeys.filter((k) => !keys.includes(k))
      if (plan.kind === 'unchanged' && toAdd.length === 0 && toRemove.length === 0) {
        setResult({ kind: 'nothing' })
        return
      }
      if (plan.kind === 'edit') await update.mutateAsync(plan.edit satisfies TaskEdit)
      for (const clauseKey of toAdd) await link.mutateAsync({ taskId: task.id, clauseKey })
      for (const clauseKey of toRemove) await unlink.mutateAsync({ taskId: task.id, clauseKey })
      setSelfSave(true)
      const what = [...(plan.kind === 'edit' ? plan.changed : []), ...(toAdd.length + toRemove.length > 0 ? ['requirements'] : [])]
      setResult({ kind: 'saved', what: what.join(', ') })
    })

  const doArchive = () =>
    run(async () => {
      await archive.mutateAsync({ id: task.id })
    })

  const completed = completionLabel(task)
  const refs = props.requirementKeys.map((k) => ({ key: k, ref: printedRef.get(k) ?? k }))

  return (
    <div className="mt-2 space-y-3 border-t border-slate-100 pt-2" data-testid={`task-details-${task.id}`}>
      <section>
        <h4 id={fid('h-desc')} className={SECTION_HEADING}>
          Description
        </h4>
        {task.detail ? (
          <p className="mt-0.5 text-sm whitespace-pre-line text-slate-700">{task.detail}</p>
        ) : (
          <p className="mt-0.5 text-sm text-slate-500 italic">No description.</p>
        )}
      </section>

      {task.state === 'blocked' && (
        <section className="rounded border-l-4 border-amber-500 bg-amber-50 p-2" data-testid={`task-blocker-${task.id}`}>
          <h4 id={fid('h-block')} className="text-[11px] font-semibold tracking-wide text-amber-900 uppercase">
            Blocker
          </h4>
          <p className="mt-0.5 text-sm text-amber-950">
            No blocker reason is recorded. Reqon keeps only the Blocked state, not a separate reason or a link to the
            work it waits on — ask the owner, or write the reason in the description.
          </p>
        </section>
      )}

      <section data-testid={`task-links-${task.id}`}>
        <h4 id={fid('h-links')} className={SECTION_HEADING}>
          Linked work
        </h4>
        <ul className="mt-0.5 space-y-0.5 text-sm text-slate-700">
          <li>
            Milestone:{' '}
            {task.milestone_key ? (
              <Link className="underline underline-offset-2" to={`/gantt?open=${encodeURIComponent(task.milestone_key)}`}>
                {props.milestones.find((m) => m.value === task.milestone_key)?.label ?? task.milestone_key}
              </Link>
            ) : (
              <span className="text-slate-500 italic">none</span>
            )}
            {task.milestone_key && <span className="text-slate-500">{task.section_id ? ' · in a section' : ' · not in a section'}</span>}
          </li>
          <li>
            Requirements:{' '}
            {refs.length === 0 ? (
              <span className="text-slate-500 italic">none linked</span>
            ) : (
              refs.map((r, i) => (
                <span key={r.key}>
                  {i > 0 && ', '}
                  <Link className="font-mono text-xs underline underline-offset-2" to={`/register?search=${encodeURIComponent(r.ref)}`}>
                    {r.ref}
                  </Link>
                </span>
              ))
            )}
          </li>
        </ul>
      </section>

      <section>
        <h4 id={fid('h-prov')} className={SECTION_HEADING}>
          Where it came from
        </h4>
        {props.source ? (
          <p className="mt-0.5 text-xs text-slate-600" data-testid={`task-source-${task.id}`}>
            Created from the proposal{' '}
            <Link className="font-medium underline underline-offset-2" to={`/archive?tab=proposals&id=${props.source.id}`}>
              “{props.source.title}”
            </Link>
            .
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-slate-600">Not created from a proposal (an older task).</p>
        )}
        {completed && <p className="text-xs text-slate-600">{completed}</p>}
      </section>

      {lostAccess && (
        <p role="status" className="rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="task-lost-access">
          You can no longer change this task: its owner or its department&apos;s Head changed. What you typed is
          still here, but it cannot be saved.
        </p>
      )}
      {changedElsewhere && (
        <div role="status" className="rounded bg-blue-50 p-2 text-sm text-blue-900" data-testid="task-changed-elsewhere">
          Someone else changed this task while you had it open. Your unsaved edits are kept; saving replaces only the
          fields you changed.{' '}
          <button type="button" onClick={takeServerValues} className="font-medium underline underline-offset-2">
            Discard mine and show theirs
          </button>
        </div>
      )}

      {perms.canEdit ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          className="space-y-3"
        >
          <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">Edit this task</legend>
            <div className="sm:col-span-2">
              <label htmlFor={fid('title')} className={LABEL}>
                Title
              </label>
              <input id={fid('title')} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={fid('detail')} className={LABEL}>
                Description
              </label>
              <textarea id={fid('detail')} rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} className={FIELD} />
            </div>
            <div>
              <label htmlFor={fid('start')} className={LABEL}>
                Start date
              </label>
              <input id={fid('start')} type="date" value={start} onChange={(e) => setStart(e.target.value)} className={FIELD} />
              {!task.starts_on && <p className="mt-1 text-xs text-slate-500">No start date recorded.</p>}
            </div>
            <div>
              <label htmlFor={fid('due')} className={LABEL}>
                Deadline
              </label>
              <input id={fid('due')} type="date" value={due} onChange={(e) => setDue(e.target.value)} className={FIELD} />
              {!task.due_date && <p className="mt-1 text-xs text-slate-500">No deadline yet.</p>}
              {task.links_required && task.due_date && (
                <p className="mt-1 text-xs text-slate-500">Created from a proposal: the deadline can change but not be removed.</p>
              )}
            </div>
            <div>
              <label htmlFor={fid('priority')} className={LABEL}>
                Priority
              </label>
              <select id={fid('priority')} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={FIELD}>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {TASK_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={fid('milestone')} className={LABEL}>
                Milestone
              </label>
              <select id={fid('milestone')} value={milestone} onChange={(e) => setMilestone(e.target.value)} className={FIELD}>
                <option value="">{task.milestone_key ? 'Keep the current milestone' : 'No milestone'}</option>
                {props.milestones.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={fid('owner')} className={LABEL}>
                Owner
              </label>
              {perms.canReassign ? (
                <select id={fid('owner')} value={owner} onChange={(e) => setOwner(e.target.value)} className={FIELD}>
                  <option value="">Unassigned</option>
                  {props.owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p id={fid('owner')} className="mt-1 min-h-11 py-2 text-sm text-slate-800 sm:min-h-0 sm:py-1.5">
                  {props.owners.find((o) => o.id === task.owner_id)?.name ?? 'Unassigned'}{' '}
                  <span className="text-xs text-slate-500">(only the department Head or a Developer can reassign)</span>
                </p>
              )}
            </div>
            <div className="sm:col-span-2" role="group" aria-labelledby={fid('req')}>
              <p id={fid('req')} className={LABEL}>
                Related requirements
              </p>
              <RequirementPicker id={fid('reqpick')} options={options} selected={keys} onChange={setKeys} disabled={busy} />
              {task.links_required && (
                <p className="mt-1 text-xs text-slate-500">A task created from a proposal must keep at least one requirement.</p>
              )}
            </div>
          </fieldset>

          <ActionError error={error} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={buttonPrimary} disabled={busy} data-testid={`task-save-${task.id}`}>
              {busy ? 'Saving…' : dirtyKeys ? 'Save details and requirements' : 'Save details'}
            </button>
            {result && !busy && (
              <span role="status" className={`text-sm ${result.kind === 'saved' ? 'text-green-700' : 'text-slate-600'}`} data-testid={`task-save-result-${task.id}`}>
                {result.kind === 'saved' ? `Saved: ${result.what}.` : 'Nothing to save — no field was changed.'}
              </span>
            )}
          </div>
        </form>
      ) : (
        <div className="space-y-1 text-sm text-slate-700" data-testid={`task-readonly-${task.id}`}>
          <p>
            <span className="font-medium">Start:</span> {task.starts_on ? formatDay(task.starts_on) : 'not recorded'} ·{' '}
            <span className="font-medium">Deadline:</span> {task.due_date ? formatDay(task.due_date) : 'not set'} ·{' '}
            <span className="font-medium">Priority:</span> {TASK_PRIORITY_LABEL[task.priority]}
          </p>
          <p className="text-xs text-slate-500">
            Read-only for you. Its owner, its department&apos;s Head or a Developer can change it.
          </p>
        </div>
      )}

      {perms.canArchive && (
        <div className="border-t border-slate-100 pt-2">
          {confirmArchive ? (
            <div role="alertdialog" aria-label="Archive this task" className="rounded border border-slate-300 bg-slate-50 p-2">
              <p className="text-sm text-slate-800">
                Archive this task? It leaves the Board and moves to the Archive, where it and its history stay. Its
                department Head or a Developer can restore it.
                {task.state !== 'done' &&
                  ' It is not finished, so it is archived as unfinished: it still counts in its milestone and requirement progress as not done.'}
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <button type="button" className={buttonDanger} disabled={busy} onClick={() => void doArchive()} data-testid={`task-archive-confirm-${task.id}`}>
                  {busy ? 'Archiving…' : 'Yes, archive it'}
                </button>
                <button type="button" className={buttonSecondary} disabled={busy} onClick={() => setConfirmArchive(false)}>
                  Keep it on the Board
                </button>
              </div>
              <ActionError error={error} className="mt-2" />
            </div>
          ) : (
            <button type="button" className={buttonSecondary} onClick={() => setConfirmArchive(true)} data-testid={`task-archive-${task.id}`}>
              Archive…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
