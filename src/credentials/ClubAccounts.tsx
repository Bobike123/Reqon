import { useId, useState, type FormEvent } from 'react'
import { revealClubCredential, useClubCredentials, useSaveClubCredential, type ClubCredential } from '../data/useClubCredentials.ts'
import { useMembers } from '../data/useMembers.ts'
import { formatInstant } from '../lib/dates.ts'
import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { ActionError, ErrorState, LoadingState } from '../ui/states.tsx'
import { copyToClipboard } from './clipboard.ts'

// 16px on a phone, so iOS does not zoom the page when a field is tapped.
const input =
  'mt-1 block min-h-11 w-full rounded border border-slate-300 bg-white px-2.5 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-9 sm:text-sm'

// The same twelve dots for every account, whatever the password is: the length of a password is a hint too.
const MASK = '••••••••••••'

// Settings → Club accounts (President, Developer): the logins for the services the club runs on (Cloudflare,
// Supabase, Vercel), so the club can still reach them if the person who set them up cannot be reached.
// The passwords are never put on the page. Each row shows a fixed mask and a Copy button; pressing it fetches
// the password from the database (which checks the role again and records who copied it) and puts it
// straight on the clipboard.
export function ClubAccountsPanel() {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-2" data-testid="club-accounts-panel">
      <p className="text-sm text-slate-700">
        The logins for the services the club runs on. Passwords stay hidden; you can only copy them. Only the President and
        Developers can open this.
      </p>
      <button type="button" className={buttonSecondary} onClick={() => setOpen(true)} data-testid="club-accounts-open">
        Open club accounts
      </button>
      <ClubAccountsDialog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

// The overlay. Its content is mounted only while open, so nothing is read from the database until someone
// opens it, and every opening starts clean.
export function ClubAccountsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="club-accounts-title">
      <AccountsContent onClose={onClose} />
    </Dialog>
  )
}

function AccountsContent({ onClose }: { onClose: () => void }) {
  const accounts = useClubCredentials(true)
  const members = useMembers()
  const nameOf = (id: string | null) => (id ? (members.data?.find((m) => m.id === id)?.full_name ?? null) : null)

  return (
    <div className="space-y-3" data-testid="club-accounts-dialog">
      <h2 id="club-accounts-title" className="text-lg font-semibold text-slate-900">
        Club accounts
      </h2>
      <p className="text-sm text-slate-700">
        Press <strong>Copy password</strong>, then paste it into the service’s sign-in page. The password is never shown, and
        every copy is recorded.
      </p>

      {accounts.error ? (
        <ErrorState title="Could not load the club accounts" error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : accounts.isPending ? (
        <LoadingState label="Loading the club accounts…" />
      ) : (
        <ul className="space-y-2">
          {accounts.data.map((account) => (
            <AccountRow key={account.id} account={account} copiedBy={nameOf(account.last_revealed_by)} />
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button type="button" className={buttonPrimary} onClick={onClose} data-testid="club-accounts-close">
          Close
        </button>
      </div>
    </div>
  )
}

type Copied = 'password' | 'login' | 'saved' | null

function AccountRow({ account, copiedBy }: { account: ClubCredential; copiedBy: string | null }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Copied>(null)
  const [error, setError] = useState<Error | null>(null)
  const [editing, setEditing] = useState(false)
  const hasPassword = account.has_secret === true

  const run = async (what: 'password' | 'login') => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      // The password goes from the server to the clipboard without passing through React state or the page.
      await copyToClipboard(what === 'password' ? revealClubCredential(account.id) : account.login)
      setDone(what)
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Copying failed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded border border-slate-200 bg-white p-3" data-testid={`account-${account.service.toLowerCase()}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-slate-900">{account.service}</h3>
        {!hasPassword && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-950">No password saved yet</span>
        )}
      </div>

      <dl className="mt-2 space-y-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <dt className="text-xs font-medium text-slate-600">Login</dt>
            <dd className="break-all text-slate-900" data-testid={`login-${account.service.toLowerCase()}`}>
              {account.login || <span className="text-slate-500">Not filled in yet</span>}
            </dd>
          </div>
          {account.login && (
            <button type="button" className={buttonSecondary} onClick={() => void run('login')} disabled={busy}>
              Copy login
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <dt className="text-xs font-medium text-slate-600">Password</dt>
            <dd className="font-mono tracking-widest text-slate-900 select-none" role="img" aria-label="Password hidden" data-testid="password-mask">
              {hasPassword ? MASK : '—'}
            </dd>
          </div>
          <button type="button" className={buttonPrimary} onClick={() => void run('password')} disabled={busy || !hasPassword} data-testid="copy-password">
            {busy ? 'Copying…' : 'Copy password'}
          </button>
        </div>
      </dl>

      <div aria-live="polite">
        {done === 'password' && (
          <p role="status" className="mt-2 text-xs text-green-800" data-testid="copied-note">
            Password copied. Paste it into the sign-in page; it stays on your clipboard until you copy something else.
          </p>
        )}
        {done === 'login' && (
          <p role="status" className="mt-2 text-xs text-green-800">
            Login copied.
          </p>
        )}
        {done === 'saved' && (
          <p role="status" className="mt-2 text-xs text-green-800">
            Saved.
          </p>
        )}
      </div>
      <ActionError error={error} className="mt-2" />

      {account.last_revealed_at && (
        <p className="mt-2 text-xs text-slate-600" data-testid="last-copied">
          Last copied by {copiedBy ?? 'someone'} on {formatInstant(account.last_revealed_at)}.
        </p>
      )}

      {editing ? (
        <EditForm
          account={account}
          onDone={(saved) => {
            setEditing(false)
            setError(null)
            setDone(saved ? 'saved' : null)
          }}
        />
      ) : (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900"
            onClick={() => {
              setDone(null)
              setEditing(true)
            }}
          >
            {hasPassword ? 'Change login or password' : 'Add login and password'}
          </button>
        </div>
      )}
    </li>
  )
}

function EditForm({ account, onDone }: { account: ClubCredential; onDone: (saved: boolean) => void }) {
  const ids = useId()
  const save = useSaveClubCredential()
  const [login, setLogin] = useState(account.login)
  const [secret, setSecret] = useState('')
  const hasPassword = account.has_secret === true
  const unchanged = login.trim() === account.login && secret === ''

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (save.isPending || unchanged) return
    save.mutate({ id: account.id, login: login.trim(), secret }, { onSuccess: () => onDone(true) })
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded border border-slate-200 bg-slate-50 p-3" data-testid={`edit-${account.service.toLowerCase()}`}>
      <div>
        <label htmlFor={`${ids}-login`} className="text-xs font-medium text-slate-700">
          Login (e-mail or username)
        </label>
        <input
          id={`${ids}-login`}
          className={input}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor={`${ids}-secret`} className="text-xs font-medium text-slate-700">
          {hasPassword ? 'New password' : 'Password'}
        </label>
        <input
          id={`${ids}-secret`}
          type="password"
          className={input}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          maxLength={500}
          autoComplete="new-password"
          placeholder={hasPassword ? 'Leave empty to keep the saved one' : ''}
        />
        <p className="mt-1 text-xs text-slate-600">
          It is stored encrypted and can only be copied afterwards, not read. Replacing it does not change the password on the
          service itself.
        </p>
      </div>
      <ActionError error={save.error} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonPrimary} disabled={save.isPending || unchanged}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={buttonSecondary} onClick={() => onDone(false)} disabled={save.isPending}>
          Cancel
        </button>
      </div>
    </form>
  )
}
