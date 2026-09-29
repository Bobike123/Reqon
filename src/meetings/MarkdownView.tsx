import Markdown, { type Components } from 'react-markdown'

// A meeting's agenda or minutes, as stored (Markdown: "## Heading", "- point",
// two spaces before "-" for a sub-point), drawn as headings, paragraphs and
// nested lists. Safe by construction: raw HTML in the text is dropped
// (skipHtml), only the elements below are ever produced, and react-markdown's
// URL filter removes javascript: and similar links. Loaded on demand
// (MeetingText.tsx), so the app shell does not pay for the parser.
//
// Headings inside the text sit under the meeting's own title (an h3), so they
// are drawn one level below it whatever level they were written at.
const heading = 'mt-3 text-sm font-semibold text-slate-900 first:mt-0'
const subheading = 'mt-2 text-sm font-medium text-slate-800 first:mt-0'
const list = 'mt-1 space-y-0.5 pl-5 text-sm text-slate-800 [&_ol]:mt-0.5 [&_ul]:mt-0.5'

const components: Components = {
  h1: ({ children }) => <h4 className={heading}>{children}</h4>,
  h2: ({ children }) => <h4 className={heading}>{children}</h4>,
  h3: ({ children }) => <h5 className={subheading}>{children}</h5>,
  h4: ({ children }) => <h5 className={subheading}>{children}</h5>,
  h5: ({ children }) => <h5 className={subheading}>{children}</h5>,
  h6: ({ children }) => <h5 className={subheading}>{children}</h5>,
  p: ({ children }) => <p className="mt-1 text-sm text-pretty text-slate-800 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className={`list-disc ${list}`}>{children}</ul>,
  ol: ({ children }) => <ol className={`list-decimal ${list}`}>{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ),
  code: ({ children }) => <code className="rounded bg-slate-100 px-1 font-mono text-xs">{children}</code>,
  blockquote: ({ children }) => <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 text-slate-700">{children}</blockquote>,
}

const ALLOWED = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'a', 'code', 'blockquote', 'br', 'hr']

export default function MarkdownView({ text }: { text: string }) {
  return (
    <Markdown skipHtml allowedElements={ALLOWED} unwrapDisallowed components={components}>
      {text}
    </Markdown>
  )
}
