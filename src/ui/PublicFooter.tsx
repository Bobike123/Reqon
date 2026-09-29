import { NavLink } from 'react-router-dom'

// Footer for the screens a signed-out visitor can see: the sign-in form and the
// privacy policy. Kept to what someone needs before they have an account.
export function PublicFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-xs text-slate-600 sm:px-6">
        <p>Reqon · SDU Motorbike Club</p>
        <nav aria-label="Legal">
          <NavLink
            to="/privacy"
            className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 sm:min-h-0"
          >
            Privacy policy
          </NavLink>
        </nav>
      </div>
    </footer>
  )
}
