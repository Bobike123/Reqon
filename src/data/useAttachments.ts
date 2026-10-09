import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { DataError } from '../core/errors.ts'
import type { Database } from '../lib/database.types.ts'
import { supabase } from '../lib/supabase.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

// Task attachments (docs/ultraplan Phase 3). Rows come from Postgres under RLS (members see `ready` and
// `deleted` rows; this list shows `ready` only). File bytes never pass through here: the Edge Functions
// (supabase/functions/attachment-*) hand out short-lived signed URLs after the database said yes, and the
// browser talks to the bucket directly.

export type Attachment = Pick<
  Database['public']['Tables']['task_attachments']['Row'],
  | 'id'
  | 'task_id'
  | 'kind'
  | 'original_name'
  | 'mime_type'
  | 'size_bytes'
  | 'width'
  | 'height'
  | 'duration_ms'
  | 'playable'
  | 'caption'
  | 'uploaded_by'
  | 'created_at'
>

const COLUMNS = 'id, task_id, kind, original_name, mime_type, size_bytes, width, height, duration_ms, playable, caption, uploaded_by, created_at'

export function useTaskAttachments(taskId: string): UseQueryResult<Attachment[], Error> {
  return useQuery({
    queryKey: queryKeys.taskAttachments(taskId),
    queryFn: async () =>
      unwrap(
        'load the files of this task',
        await supabase
          .from('task_attachments')
          .select(COLUMNS)
          .eq('task_id', taskId)
          .eq('status', 'ready')
          .order('created_at')
          .order('id'),
      ),
  })
}

// Live while a task's details are open: someone else's upload appears, a deletion elsewhere removes the
// tile. The payload is not patched in (it carries object keys the list never selects); the list is refetched.
export function useRealtimeTaskAttachments(taskId: string): void {
  const queryClient = useQueryClient()
  const auth = useAuth()
  const userId = auth.status === 'member' ? auth.user.id : null
  useEffect(() => {
    if (!userId) return
    let active = true
    const refresh = () => {
      if (active) void queryClient.invalidateQueries({ queryKey: queryKeys.taskAttachments(taskId) })
    }
    const channel = supabase
      .channel(`task_attachments-${taskId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_attachments', filter: `task_id=eq.${taskId}` }, refresh)
      .subscribe((status: string) => {
        // After a reconnect, close whatever gap the socket missed.
        if (status === 'SUBSCRIBED') refresh()
      })
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [taskId, userId, queryClient])
}

// ------------------------------------------------------------------ Edge Function calls
// A refusal from an attachment function, with the HTTP status so callers can tell "try again" (409 with
// retry) from "not allowed" (403) from "gone" (404).
export class AttachmentFunctionError extends DataError {
  status: number
  retry: boolean
  constructor(message: string, status: number, options: { permission?: boolean; retry?: boolean } = {}) {
    super(message, null, { permission: options.permission ?? false })
    this.name = 'AttachmentFunctionError'
    this.status = status
    this.retry = options.retry ?? false
  }
}

// Shared with the backup panel: every Edge Function here answers { error, retry? } worded for a club member.
export async function invoke<T>(name: string, body: Record<string, unknown>, what: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body })
  if (!error) {
    if (data === null || data === undefined) throw new AttachmentFunctionError(`${what}: the server sent no answer.`, 0)
    return data
  }
  // The functions answer { error, retry? } worded for a club member; a gateway failure is not JSON.
  const response = (error as { context?: unknown }).context
  let status = 0
  let message: string | null = null
  let retry = false
  if (response instanceof Response) {
    status = response.status
    try {
      const parsed: unknown = await response.json()
      if (parsed && typeof parsed === 'object') {
        const b = parsed as { error?: unknown; retry?: unknown }
        if (typeof b.error === 'string') message = b.error
        retry = b.retry === true
      }
    } catch {
      // Not JSON: keep the generic wording below.
    }
  }
  if (status === 401) throw new AttachmentFunctionError(message ?? 'Your session has expired. Sign in again.', 401)
  if (status === 403) {
    throw new AttachmentFunctionError(message ?? `You don't have permission to ${what}.`, 403, { permission: true })
  }
  if (status === 0) throw new AttachmentFunctionError(`Could not ${what}: no connection to the server. Check your internet connection and try again.`, 0, { retry: true })
  throw new AttachmentFunctionError(message ?? `Could not ${what} (error ${status}). Try again.`, status, { retry })
}

export type UploadReservationRequest = {
  taskId: string
  kind: 'photo' | 'document' | 'video'
  mimeType: string
  sizeBytes: number
  originalName: string
  width: number | null
  height: number | null
  durationMs: number | null
  playable: boolean
  thumbMimeType: 'image/webp' | 'image/jpeg'
}

export type SignedRequest = { url: string; method: 'PUT'; headers: Record<string, string> }

export type UploadReservation = {
  attachmentId: string
  expiresIn: number
  upload: SignedRequest
  thumbnail: SignedRequest | null
}

export function requestAttachmentUpload(request: UploadReservationRequest): Promise<UploadReservation> {
  return invoke<UploadReservation>('attachment-upload-url', request, 'start this upload')
}

export async function confirmAttachmentUpload(attachmentId: string): Promise<'ready' | 'failed' | 'deleted'> {
  const answer = await invoke<{ status: 'ready' | 'failed' | 'deleted' | 'pending' }>(
    'attachment-confirm',
    { attachmentId },
    'finish this upload',
  )
  if (answer.status === 'pending') throw new AttachmentFunctionError('The upload is not finished yet.', 409, { retry: true })
  return answer.status
}

export type SignedUrls = { urls: Record<string, string>; expiresIn: number; fetchedAt: number }

const DOWNLOAD_BATCH = 60

export async function fetchAttachmentUrls(
  ids: readonly string[],
  variant: 'thumb' | 'original',
  download = false,
): Promise<SignedUrls> {
  const fetchedAt = Date.now()
  const urls: Record<string, string> = {}
  let expiresIn = 3600
  for (let i = 0; i < ids.length; i += DOWNLOAD_BATCH) {
    const answer = await invoke<{ urls: Record<string, string>; expiresIn: number }>(
      'attachment-download-url',
      { attachmentIds: ids.slice(i, i + DOWNLOAD_BATCH), variant, download },
      'open this file',
    )
    Object.assign(urls, answer.urls)
    expiresIn = Math.min(expiresIn, answer.expiresIn)
  }
  return { urls, expiresIn, fetchedAt }
}

// Posters and thumbnails of one task, fetched in one batch. A signed URL lives an hour; the cache keeps
// it for 45 minutes, so a tile never shows an expired link after a long pause.
export function useAttachmentThumbUrls(ids: readonly string[]): UseQueryResult<SignedUrls, Error> {
  return useQuery({
    queryKey: queryKeys.attachmentUrls('thumb', ids),
    queryFn: () => fetchAttachmentUrls(ids, 'thumb'),
    enabled: ids.length > 0,
    staleTime: 45 * 60 * 1000,
    gcTime: 50 * 60 * 1000,
    refetchInterval: 45 * 60 * 1000,
  })
}

// --------------------------------------------------------------------------- mutations
export function useDeleteAttachment(taskId: string) {
  const queryClient = useQueryClient()
  return useMutation<boolean, Error, string>({
    mutationFn: async (attachmentId) =>
      unwrap('delete this file', await supabase.rpc('delete_attachment', { p_attachment_id: attachmentId })),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskAttachments(taskId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.attachmentUsage })
    },
  })
}

// Used by the upload queue to give back a reservation it will not finish (cancel / failure). Best effort:
// an unfinished reservation is failed by the hourly sweep anyway.
export async function releaseAttachmentReservation(attachmentId: string): Promise<void> {
  await supabase.rpc('delete_attachment', { p_attachment_id: attachmentId })
}

export function useSetAttachmentCaption(taskId: string) {
  const queryClient = useQueryClient()
  return useMutation<boolean, Error, { attachmentId: string; caption: string }>({
    mutationFn: async ({ attachmentId, caption }) =>
      unwrap(
        'change this caption',
        await supabase.rpc('set_attachment_caption', { p_attachment_id: attachmentId, p_caption: caption }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskAttachments(taskId) })
    },
  })
}

export type AttachmentUsage = { quotaGroup: 'video' | 'photo_document'; usedBytes: number; quotaBytes: number }

export function useAttachmentUsage(enabled: boolean): UseQueryResult<AttachmentUsage[], Error> {
  return useQuery({
    queryKey: queryKeys.attachmentUsage,
    enabled,
    queryFn: async () =>
      unwrap('load the storage usage', await supabase.rpc('attachment_usage')).map((row) => ({
        quotaGroup: row.quota_group === 'video' ? 'video' : 'photo_document',
        usedBytes: Number(row.used_bytes),
        quotaBytes: Number(row.quota_bytes),
      })),
  })
}
