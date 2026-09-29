import { useRef, useState } from 'react'
import { MeetingText } from './MeetingText.tsx'

const tab = (active: boolean) =>
  `min-h-11 rounded px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 ${
    active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
  }`

// A Markdown text box with a preview drawn exactly as the meeting will be read
// (MeetingText), so writing and reading look the same. The text itself is what
// is stored; the preview never changes it.
export function MarkdownField({
  id,
  label,
  value,
  onChange,
  rows = 8,
  placeholder,
  note,
  disabled = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
  note?: string
  disabled?: boolean
}) {
  const [preview, setPreview] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  // The formatting buttons write the same Markdown a person would type, at the
  // cursor: a prefix on each selected line, or ** around the selection.
  function format(kind: 'heading' | 'bullet' | 'sub' | 'numbered' | 'bold') {
    const el = box.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    let next: string
    let caret: [number, number]
    if (kind === 'bold') {
      const picked = value.slice(start, end) || 'bold text'
      next = `${value.slice(0, start)}**${picked}**${value.slice(end)}`
      caret = [start + 2, start + 2 + picked.length]
    } else {
      const prefix = { heading: '## ', bullet: '- ', sub: '  - ', numbered: '1. ' }[kind]
      const lineStart = value.lastIndexOf('\n', start - 1) + 1
      const block = value.slice(lineStart, end)
      const lines = block.split('\n').map((line) => prefix + line.replace(/^(#{1,6} |\s*[-*] |\s*\d+\. )/, ''))
      next = value.slice(0, lineStart) + lines.join('\n') + value.slice(end)
      const added = lines.join('\n').length - block.length
      caret = [start + prefix.length, end + added]
    }
    onChange(next)
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(caret[0], caret[1])
    })
  }
  const tool =
    'min-h-11 rounded px-2 text-xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-50 sm:min-h-0 sm:py-0.5'

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block text-xs font-medium text-slate-600" htmlFor={id}>
          {label}
        </label>
        <div role="group" aria-label={`${label}: write or preview`} className="inline-flex gap-0.5 rounded-md border border-slate-300 bg-white p-0.5">
          <button type="button" aria-pressed={!preview} className={tab(!preview)} onClick={() => setPreview(false)}>
            Write
          </button>
          <button type="button" aria-pressed={preview} className={tab(preview)} onClick={() => setPreview(true)} data-testid={`${id}-preview-toggle`}>
            Preview
          </button>
        </div>
      </div>
      {!preview && (
        <div role="toolbar" aria-label={`Format ${label}`} className="mt-1 flex flex-wrap gap-0.5 rounded-t border border-b-0 border-slate-300 bg-slate-50 p-0.5">
          <button type="button" className={tool} disabled={disabled} onClick={() => format('heading')}>
            Heading
          </button>
          <button type="button" className={tool} disabled={disabled} onClick={() => format('bullet')}>
            • Point
          </button>
          <button type="button" className={tool} disabled={disabled} onClick={() => format('sub')}>
            ◦ Sub-point
          </button>
          <button type="button" className={tool} disabled={disabled} onClick={() => format('numbered')}>
            1. Numbered
          </button>
          <button type="button" className={`${tool} font-bold`} disabled={disabled} onClick={() => format('bold')}>
            Bold
          </button>
        </div>
      )}
      <textarea
        ref={box}
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        hidden={preview}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-describedby={`${id}-help`}
        className="w-full rounded-b border border-slate-300 px-2 py-1.5 font-mono text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
      />
      {preview && (
        <div className="mt-1 max-h-80 overflow-auto rounded border border-slate-200 bg-slate-50 p-2" data-testid={`${id}-preview`}>
          {value.trim() ? <MeetingText text={value} /> : <p className="text-sm text-slate-500">Nothing written yet.</p>}
        </div>
      )}
      <p id={`${id}-help`} className="mt-1 text-xs text-slate-500">
        {note ? `${note} ` : ''}Formatting: <code>## Heading</code>, <code>- point</code>, two spaces before <code>-</code> for a
        sub-point, <code>**bold**</code>.
      </p>
    </div>
  )
}
