import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/context.ts'
import {
  PRIVILEGED_ROLES,
  ROLE_LABELS,
  ROLE_SUMMARIES,
  describeRoles,
  type PrivilegedRole,
} from '../auth/permissions.ts'
import { RoleChangeError, roleKeys, useApplyRoleChanges, useMemberRoles } from '../data/useSettings.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError, ErrorState, LoadingState } from '../ui/states.tsx'
import { joinNames, planRoleChanges, type Person } from './rolePlan.ts'

type Apply = ReturnType<typeof useApplyRoleChanges>

// The President's role editor for one member, opened from Settings → Roster.
//
// It only PROPOSES. The database decides: role_assign / role_remove let only
// the President write member_roles, and a trigger refuses to remove the last
// President. What this adds is the human part — saying what a change means
// before it happens, and asking twice for the ones that matter.
export function RoleDialog({
  member,
  people,
  onClose,
  onChanged,
}: {
  member: Person | null
  people: readonly Person[]
  onClose: () => void
  onChanged: (message: string) => void
}) {
  const titleId = useId()
  const apply = useApplyRoleChanges()
  const close = () => {
    apply.reset()
    onClose()
  }
  return (
    <Dialog open={member !== null} onClose={close} labelledBy={titleId} dismissible={!apply.isPending}>
      {member && (
        <RoleEditor
          member={member}
          people={people}
          titleId={titleId}
          apply={apply}
          onCancel={close}
          onDone={(message) => {
            apply.reset()
            onChanged(message)
          }}
        />
      )}
    </Dialog>
  )
}

function RoleEditor({
  member,
  people,
  titleId,
  apply,
  onCancel,
  onDone,
}: {
  member: Person
  people: readonly Person[]
  titleId: string
  apply: Apply
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const roleRows = useMemberRoles()
  const confirmHeading = useRef<HTMLHeadingElement>(null)
  const [edited, setEdited] = useState<PrivilegedRole[] | null>(null)
  const [replaceTreasurer, setReplaceTreasurer] = useState(true)
  const [stepDown, setStepDown] = useState(false)
  const [step, setStep] = useState<'edit' | 'confirm'>('edit')

  // The roster on screen can be a minute old. Re-read who holds what the
  // moment the editor opens, so a change is planned against what is saved.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: roleKeys.all })
  }, [queryClient])

  useEffect(() => {
    if (step === 'confirm') confirmHeading.current?.focus()
  }, [step])

  if (roleRows.isPending) return <LoadingState label="Loading current roles…" />
  if (roleRows.error && !roleRows.data) {
    return (
      <ErrorState title="Could not load roles" error={roleRows.error} onRetry={() => void roleRows.refetch()} />
    )
  }

  const me: Person =
    auth.status === 'member' ? { id: auth.member.id, name: auth.member.full_name } : { id: '', name: '' }
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Someone not on the roster'
  const holders = Object.fromEntries(
    PRIVILEGED_ROLES.map((role) => [
      role,
      (roleRows.data ?? [])
        .filter((row) => row.role === role)
        .map((row) => ({ id: row.member_id, name: nameOf(row.member_id) })),
    ]),
  ) as Record<PrivilegedRole, Person[]>
  const current = PRIVILEGED_ROLES.filter((role) => holders[role].some((p) => p.id === member.id))
  // Until the President ticks something, follow what is saved: a refresh that
  // lands while this is open must not turn into a change nobody asked for.
  const desired = edited ?? current
  const plan = planRoleChanges({ target: member, desired, me, holders, replaceTreasurer, stepDown })
  const isMe = member.id === me.id
  const selfDemotion = plan.changes.some(
    (c) => c.role === 'president' && c.action === 'remove' && c.memberId === me.id,
  )
  const partial = apply.error instanceof RoleChangeError && apply.error.applied > 0 ? apply.error : null
  const nothingToDo = plan.changes.length === 0
  const others = plan.otherTreasurers

  function toggle(role: PrivilegedRole, on: boolean) {
    setEdited(on ? [...desired, role] : desired.filter((r) => r !== role))
  }

  async function run() {
    try {
      await apply.mutateAsync(plan.changes)
      onDone(`Roles updated for ${member.name}.`)
    } catch {
      // The refusal is on screen (apply.error). Back to the choices, which now
      // show what was actually saved.
      setStep('edit')
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (apply.isPending || plan.blocked || nothingToDo) return
    if (step === 'edit' && plan.needsConfirmation) {
      setStep('confirm')
      return
    }
    void run()
  }

  return (
    <form onSubmit={submit} noValidate>
      <h2 id={titleId} className="text-base font-semibold text-balance text-slate-900">
        Roles for {member.name}
        {isMe ? ' (you)' : ''}
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Now: <span className="font-medium text-slate-900">{describeRoles(current)}</span>
      </p>

      {step === 'edit' ? (
        <>
          <fieldset className="mt-4" disabled={apply.isPending}>
            <legend className="text-sm font-medium text-slate-900">Privileged roles</legend>
            <p className="text-xs text-pretty text-slate-600">
              Tick any combination. With none ticked, {isMe ? 'you are' : `${member.name} is`} an
              ordinary member.
            </p>
            <ul className="mt-2 space-y-1.5">
              {PRIVILEGED_ROLES.map((role) => {
                const id = `${titleId}-${role}`
                return (
                  <li key={role}>
                    <label
                      htmlFor={id}
                      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:border-slate-400 has-checked:border-slate-900 has-checked:bg-slate-50"
                    >
                      <input
                        id={id}
                        type="checkbox"
                        checked={desired.includes(role)}
                        onChange={(e) => toggle(role, e.target.checked)}
                        aria-labelledby={`${id}-name`}
                        aria-describedby={`${id}-about`}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-slate-900"
                      />
                      <span className="min-w-0">
                        <span id={`${id}-name`} className="block text-sm font-medium text-slate-900">
                          {ROLE_LABELS[role]}
                        </span>
                        <span id={`${id}-about`} className="block text-xs text-pretty text-slate-600">
                          {ROLE_SUMMARIES[role]}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            {desired.length === 0 && (
              <p className="mt-2 text-sm text-slate-700">
                No privileged role — {isMe ? 'you' : member.name} will be an ordinary member.
              </p>
            )}
          </fieldset>

          {others.length > 0 && (
            <fieldset
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5"
              disabled={apply.isPending}
            >
              <legend className="sr-only">What happens to the current Treasurer</legend>
              <p className="text-sm text-amber-950">
                {joinNames(others)} {others.length === 1 ? 'is' : 'are'} Treasurer now.
              </p>
              <label className="mt-1 flex min-h-11 items-center gap-2 text-sm text-slate-900">
                <input
                  type="radio"
                  name={`${titleId}-treasurer`}
                  checked={replaceTreasurer}
                  onChange={() => setReplaceTreasurer(true)}
                  className="h-5 w-5 shrink-0 accent-slate-900"
                />
                Replace — {joinNames(others)} {others.length === 1 ? 'stops' : 'stop'} being Treasurer
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm text-slate-900">
                <input
                  type="radio"
                  name={`${titleId}-treasurer`}
                  checked={!replaceTreasurer}
                  onChange={() => setReplaceTreasurer(false)}
                  className="h-5 w-5 shrink-0 accent-slate-900"
                />
                Keep both — more than one person can change money
              </label>
            </fieldset>
          )}

          {plan.canStepDown && (
            <label className="mt-3 flex min-h-11 items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
              <input
                type="checkbox"
                checked={stepDown}
                onChange={(e) => setStepDown(e.target.checked)}
                disabled={apply.isPending}
                className="mt-0.5 h-5 w-5 shrink-0 accent-slate-900"
              />
              <span className="text-sm text-slate-900">
                Hand over: I stop being President
                <span className="block text-xs text-slate-600">
                  Leave this unticked to have two Presidents for now.
                </span>
              </span>
            </label>
          )}

          {plan.blocked && (
            <p role="alert" className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
              {plan.blocked}
            </p>
          )}
        </>
      ) : (
        <div className="mt-4">
          <h3
            ref={confirmHeading}
            tabIndex={-1}
            className="text-sm font-semibold text-slate-900 focus-visible:outline-none"
          >
            Check before you confirm
          </h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-pretty text-slate-800">
            {plan.consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-600">
            The database checks each change again. If one is refused, nothing after it is attempted.
          </p>
        </div>
      )}

      {apply.error && (
        <div className="mt-3 space-y-1">
          <ActionError error={apply.error} />
          {partial && (
            <p className="text-xs text-slate-600">
              {partial.applied} of {partial.total} changes were saved before that. The boxes above
              show what is saved now.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        {step === 'edit' ? (
          <button type="button" onClick={onCancel} disabled={apply.isPending} className={buttonSecondary}>
            Cancel
          </button>
        ) : (
          <button type="button" onClick={() => setStep('edit')} disabled={apply.isPending} className={buttonSecondary}>
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={apply.isPending || nothingToDo || plan.blocked !== null}
          className={step === 'confirm' && selfDemotion ? buttonDanger : buttonPrimary}
        >
          {apply.isPending
            ? 'Saving…'
            : nothingToDo
              ? 'No changes'
              : step === 'confirm'
                ? 'Confirm change'
                : plan.needsConfirmation
                  ? 'Review change'
                  : 'Save roles'}
        </button>
      </div>
    </form>
  )
}
