import { useEffect, useRef, type ReactNode } from 'react'

// A modal on the native <dialog>. The browser does the hard parts: the rest of
// the page becomes inert, Tab stays inside, Escape closes it, and focus goes
// back to whatever opened it (see below). Centred on wider screens; a bottom sheet on a
// phone, where it is easy to reach with a thumb.
//
// Content is only mounted while open, so every opening starts fresh.
export function Dialog({
  open,
  onClose,
  labelledBy,
  dismissible = true,
  children,
}: {
  open: boolean
  onClose: () => void
  labelledBy: string
  // False while a save is in flight: closing then would hide its outcome.
  dismissible?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // Whatever had focus when the dialog opened — usually the button that opened it.
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
      // The browser only restores focus if it is still inside the dialog, and
      // by now React has removed the control that had it. Hand it back to the
      // opener ourselves, so a keyboard user lands where they started.
      const opener = returnTo.current
      returnTo.current = null
      if (opener?.isConnected) opener.focus()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        // Escape. Keep React in charge of whether the dialog is open.
        event.preventDefault()
        if (dismissible) onClose()
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (dismissible && event.target === event.currentTarget) onClose()
      }}
      className="pc-slide-up mx-0 mt-auto mb-0 max-h-[90dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-t-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/40 sm:m-auto sm:max-h-[85dvh] sm:w-[min(34rem,calc(100%-2rem))] sm:rounded-xl"
    >
      {open && (
        <div className="px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">{children}</div>
      )}
    </dialog>
  )
}
