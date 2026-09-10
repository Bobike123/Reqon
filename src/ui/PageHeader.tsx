import type { ReactNode } from 'react'

// Every screen opens the same way: its name, and one line telling a new team
// member what the screen is for. The main navigation lives in AppHeader.
export function PageHeader({
  title,
  description,
  tutorialId,
  children,
}: {
  title: string
  description: string
  tutorialId?: string
  children?: ReactNode
}) {
  return (
    <header className="mb-4" data-tutorial={tutorialId}>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
      <p className="mt-0.5 text-sm text-slate-600">{description}</p>
      {children}
    </header>
  )
}
