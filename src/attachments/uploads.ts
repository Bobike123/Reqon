import type { QueryClient } from '@tanstack/react-query'
import { putObject } from './putObject.ts'
import { createUploadStore } from './uploadStore.ts'

// The app's one upload queue. Its tools load on the first upload: the compression code (and Mediabunny,
// inside the worker) never reaches someone who only looks at files (ATT-18).

let queryClient: QueryClient | null = null

export function bindUploadsToQueryClient(client: QueryClient): void {
  queryClient = client
}

export const uploads = createUploadStore(async () => {
  const [{ prepareFile }, api, { queryKeys }] = await Promise.all([
    import('./media/prepare.ts'),
    import('../data/useAttachments.ts'),
    import('../data/queryKeys.ts'),
  ])
  return {
    prepare: prepareFile,
    requestUpload: api.requestAttachmentUpload,
    put: putObject,
    confirm: api.confirmAttachmentUpload,
    release: api.releaseAttachmentReservation,
    onUploaded: (taskId: string) => {
      void queryClient?.invalidateQueries({ queryKey: queryKeys.taskAttachments(taskId) })
      void queryClient?.invalidateQueries({ queryKey: queryKeys.attachmentUsage })
    },
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }
})

// Leaving or reloading the page stops an upload; the browser asks first while one is running.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (uploads.busy()) event.preventDefault()
  })
}
