import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

// One page of the Requirements Book, drawn by pdf.js onto a canvas. Loaded only
// when a reader is actually opened (React.lazy in BookReader.tsx), so neither
// the app shell nor the Register pays for it.
//
// Why pdf.js and not the browser's own viewer: the page shown is STATE here.
// Changing `pageIndex` re-renders that page in the already-open document, so a
// second rule opens its own page even after another is showing, and the page
// actually drawn is exposed (data-rendered-page) for verification. A browser
// viewer behind an <object>/#page cannot promise either, and phones rarely have
// one (finding F14-08).
export default function PdfPageView({
  url,
  pageIndex,
  label,
  onDocument,
  onError,
}: {
  url: string
  // 1-based page index INSIDE the PDF (printed page + the edition's offset).
  pageIndex: number
  label: string
  onDocument: (pageCount: number) => void
  onError: (message: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // The open document and the page last drawn, each tied to the address it
  // came from: a new address shows nothing of the old document, so a page is
  // never drawn from one that is being destroyed.
  const [loaded, setLoaded] = useState<{ url: string; doc: PDFDocumentProxy } | null>(null)
  const [drawn, setDrawn] = useState<{ url: string; page: number } | null>(null)
  const doc = loaded?.url === url ? loaded.doc : null
  const rendered = drawn?.url === url ? drawn.page : null
  const [width, setWidth] = useState(0)
  const onDocumentRef = useRef(onDocument)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onDocumentRef.current = onDocument
    onErrorRef.current = onError
  })

  // Open the document once per address.
  useEffect(() => {
    let cancelled = false
    const task = getDocument({ url, enableXfa: false })
    task.promise.then(
      (opened) => {
        if (cancelled) return
        setLoaded({ url, doc: opened })
        onDocumentRef.current(opened.numPages)
      },
      (error: unknown) => {
        if (!cancelled) onErrorRef.current(error instanceof Error ? error.message : 'The document could not be read.')
      },
    )
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [url])

  // Follow the reader's width, so the page fits a narrow pane or a phone.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    if (typeof ResizeObserver === 'undefined') {
      setWidth(box.clientWidth || 800)
      return
    }
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  // Draw the requested page; a newer request cancels an unfinished one.
  useEffect(() => {
    if (!doc || width <= 0) return
    let task: RenderTask | null = null
    let cancelled = false
    const index = Math.min(Math.max(1, pageIndex), doc.numPages)
    doc.getPage(index).then((page) => {
      if (cancelled || !canvasRef.current) return
      const base = page.getViewport({ scale: 1 })
      const ratio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: (width / base.width) * ratio })
      const canvas = canvasRef.current
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`
      task = page.render({ canvas, viewport })
      task.promise.then(
        () => {
          if (!cancelled) setDrawn({ url, page: index })
        },
        // A newer page (or closing the reader) cancelled this drawing.
        () => {},
      )
    }, (error: unknown) => {
      if (!cancelled) onErrorRef.current(error instanceof Error ? error.message : 'That page could not be read.')
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageIndex, width, url])

  return (
    <div ref={boxRef} className="w-full" data-testid="book-canvas-box" data-rendered-page={rendered ?? ''} aria-busy={rendered !== pageIndex}>
      {!doc && (
        <p role="status" className="p-4 text-sm text-slate-600">
          Opening the document…
        </p>
      )}
      <canvas ref={canvasRef} role="img" aria-label={label} className="block max-w-full bg-white" />
    </div>
  )
}
