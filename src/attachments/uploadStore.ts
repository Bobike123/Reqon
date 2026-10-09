import { useSyncExternalStore } from 'react'
import { isPermissionError } from '../core/errors.ts'
import type { PreparedFile } from './media/types.ts'
import { classifyFile, type AttachmentKind } from './rules.ts'

// The upload queue (ATT-12). It lives outside React on purpose: closing a task's details, or moving to
// another page, must not kill an upload that is halfway through a 40 MB video. One file is worked on at
// a time (compression is memory-hungry on phones); each item goes
//   waiting → preparing (compress) → uploading (PUT) → finishing (confirm) → done
// or ends failed (with Try again) or cancelled. A retry reuses the compressed result.

export type UploadStage = 'waiting' | 'preparing' | 'uploading' | 'finishing' | 'done' | 'failed' | 'cancelled'

export type UploadItem = {
  id: string
  taskId: string
  fileName: string
  kind: AttachmentKind | null
  stage: UploadStage
  progress: number // 0..1 within the current stage
  error: string | null
  note: string | null
}

type SignedRequest = { url: string; headers: Record<string, string> }

export type UploadDeps = {
  prepare: (file: File, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<PreparedFile>
  requestUpload: (request: {
    taskId: string
    kind: AttachmentKind
    mimeType: string
    sizeBytes: number
    originalName: string
    width: number | null
    height: number | null
    durationMs: number | null
    playable: boolean
    thumbMimeType: 'image/webp' | 'image/jpeg'
  }) => Promise<{ attachmentId: string; upload: SignedRequest; thumbnail: SignedRequest | null }>
  put: (request: SignedRequest, body: Blob, options: { onProgress?: (fraction: number) => void; signal?: AbortSignal }) => Promise<void>
  confirm: (attachmentId: string) => Promise<'ready' | 'failed' | 'deleted'>
  release: (attachmentId: string) => Promise<void>
  onUploaded: (taskId: string) => void
  sleep: (ms: number) => Promise<void>
}

type Internal = { file: File; prepared: PreparedFile | null; controller: AbortController | null; reservation: string | null }

const ACTIVE: readonly UploadStage[] = ['waiting', 'preparing', 'uploading', 'finishing']
const CONFIRM_ATTEMPTS = 4
const DONE_LINGER_MS = 4000

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) {
    // Errors made for people (PrepareError, AttachmentFunctionError, PutError, DataError) say what to do.
    if (['PrepareError', 'AttachmentFunctionError', 'PutError', 'DataError'].includes(e.name) || isPermissionError(e)) return e.message
    return `Something went wrong (${e.message}). Try again.`
  }
  return 'Something went wrong. Try again.'
}

export function createUploadStore(getDeps: () => Promise<UploadDeps> | UploadDeps) {
  let items: UploadItem[] = []
  const internal = new Map<string, Internal>()
  const listeners = new Set<() => void>()
  let running = false
  let counter = 0

  const emit = () => {
    for (const l of listeners) l()
  }
  const patch = (id: string, change: Partial<UploadItem>) => {
    items = items.map((it) => (it.id === id ? { ...it, ...change } : it))
    emit()
  }
  const get = (id: string) => items.find((it) => it.id === id)

  async function runOne(item: UploadItem, deps: UploadDeps) {
    const data = internal.get(item.id)
    // Cancelled (or dismissed) while the tools were loading.
    if (!data || get(item.id)?.stage !== 'waiting') return
    const controller = new AbortController()
    data.controller = controller
    const signal = controller.signal
    try {
      if (!data.prepared) {
        patch(item.id, { stage: 'preparing', progress: 0, error: null })
        data.prepared = await deps.prepare(data.file, (progress) => patch(item.id, { progress }), signal)
      }
      const prepared = data.prepared
      patch(item.id, { stage: 'uploading', progress: 0, kind: prepared.kind, fileName: prepared.name })
      const reservation = await deps.requestUpload({
        taskId: item.taskId,
        kind: prepared.kind,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.blob.size,
        originalName: prepared.name,
        width: prepared.width,
        height: prepared.height,
        durationMs: prepared.durationMs,
        playable: prepared.playable,
        thumbMimeType: prepared.thumb?.type ?? 'image/webp',
      })
      data.reservation = reservation.attachmentId
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      const thumbBytes = reservation.thumbnail && prepared.thumb ? prepared.thumb.blob.size : 0
      const total = prepared.blob.size + thumbBytes
      if (reservation.thumbnail && prepared.thumb) {
        await deps.put(reservation.thumbnail, prepared.thumb.blob, {
          signal,
          onProgress: (f) => patch(item.id, { progress: (f * thumbBytes) / total }),
        })
      }
      await deps.put(reservation.upload, prepared.blob, {
        signal,
        onProgress: (f) => patch(item.id, { progress: (thumbBytes + f * prepared.blob.size) / total }),
      })

      patch(item.id, { stage: 'finishing', progress: 1 })
      let status: 'ready' | 'failed' | 'deleted' | null = null
      for (let attempt = 0; status === null; attempt++) {
        try {
          status = await deps.confirm(reservation.attachmentId)
        } catch (e) {
          const retry = e instanceof Error && (e as { retry?: unknown }).retry === true
          if (!retry || attempt + 1 >= CONFIRM_ATTEMPTS || signal.aborted) throw e
          await deps.sleep(1000 * (attempt + 1))
        }
      }
      data.reservation = null
      if (status === 'ready') {
        data.prepared = null
        patch(item.id, { stage: 'done', progress: 1, note: prepared.note })
        deps.onUploaded(item.taskId)
        if (!prepared.note) setTimeout(() => dismiss(item.id), DONE_LINGER_MS)
      } else if (status === 'failed') {
        patch(item.id, { stage: 'failed', error: 'The file did not arrive intact (its size or type changed on the way). Try again.' })
      } else {
        patch(item.id, { stage: 'failed', error: 'The file was deleted before the upload finished.' })
      }
    } catch (e) {
      const reservation = data.reservation
      data.reservation = null
      if (reservation) void deps.release(reservation).catch(() => {})
      if (isAbort(e) || signal.aborted) patch(item.id, { stage: 'cancelled', error: null })
      else patch(item.id, { stage: 'failed', error: messageOf(e) })
    } finally {
      data.controller = null
    }
  }

  async function pump() {
    if (running) return
    running = true
    try {
      for (;;) {
        const next = items.find((it) => it.stage === 'waiting')
        if (!next) break
        let deps: UploadDeps
        try {
          deps = await getDeps()
        } catch {
          patch(next.id, { stage: 'failed', error: 'The upload tools could not be loaded. Check your connection and try again.' })
          continue
        }
        await runOne(next, deps)
      }
    } finally {
      running = false
    }
  }

  function add(taskId: string, files: readonly File[]): void {
    for (const file of files) {
      const id = `u${++counter}`
      internal.set(id, { file, prepared: null, controller: null, reservation: null })
      items = [...items, { id, taskId, fileName: file.name, kind: classifyFile(file), stage: 'waiting', progress: 0, error: null, note: null }]
    }
    emit()
    void pump()
  }

  function cancel(id: string): void {
    const item = get(id)
    if (!item || !ACTIVE.includes(item.stage)) return
    const data = internal.get(id)
    if (item.stage === 'waiting' || !data?.controller) patch(id, { stage: 'cancelled' })
    else data.controller.abort()
  }

  function retry(id: string): void {
    const item = get(id)
    if (!item || (item.stage !== 'failed' && item.stage !== 'cancelled')) return
    patch(id, { stage: 'waiting', progress: 0, error: null })
    void pump()
  }

  function dismiss(id: string): void {
    const item = get(id)
    if (!item || ACTIVE.includes(item.stage)) return
    internal.delete(id)
    items = items.filter((it) => it.id !== id)
    emit()
  }

  return {
    add,
    cancel,
    retry,
    dismiss,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => items,
    busy: () => items.some((it) => ACTIVE.includes(it.stage)),
  }
}

export type UploadStore = ReturnType<typeof createUploadStore>

export function useUploads(store: UploadStore, taskId: string): UploadItem[] {
  const all = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  return all.filter((it) => it.taskId === taskId)
}

export function isActive(stage: UploadStage): boolean {
  return ACTIVE.includes(stage)
}
