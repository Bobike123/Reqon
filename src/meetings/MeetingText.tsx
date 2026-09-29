import { lazy, Suspense } from 'react'

const MarkdownView = lazy(() => import('./MarkdownView.tsx'))

// A meeting's agenda or minutes, or the default agenda, read as formatted text.
// Until the Markdown reader has loaded, the same text is shown as it was typed
// (line breaks kept), so nothing is ever hidden while it loads.
export function MeetingText({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="min-w-0 break-words" data-testid={testId}>
      <Suspense fallback={<p className="text-sm whitespace-pre-line text-slate-800">{text}</p>}>
        <MarkdownView text={text} />
      </Suspense>
    </div>
  )
}
