import { lazy, Suspense } from 'react'
import type { AttachmentPermissions } from '../auth/permissions.ts'
import { attachmentsEnabled } from './flag.ts'

// The entry point the task details render. Nothing at all while the feature flag is off (ATT-15); the
// panel itself is its own chunk, so a Board without attachments open never downloads it.
const AttachmentsPanel = lazy(() => import('./AttachmentsPanel.tsx'))

const VIEW_ONLY: AttachmentPermissions = { canUpload: false, canManageAll: false, actorId: null }

export function AttachmentsSection({ taskId, perms }: { taskId: string; perms?: AttachmentPermissions }) {
  if (!attachmentsEnabled()) return null
  return (
    <Suspense fallback={<p className="text-xs text-slate-500">Loading files…</p>}>
      <AttachmentsPanel taskId={taskId} perms={perms ?? VIEW_ONLY} />
    </Suspense>
  )
}
