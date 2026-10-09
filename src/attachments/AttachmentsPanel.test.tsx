import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentPermissions } from '../auth/permissions.ts'
import type { Attachment } from '../data/useAttachments.ts'
import AttachmentsPanel from './AttachmentsPanel.tsx'
import { AttachmentsSection } from './AttachmentsSection.tsx'
import { StorageUsage } from './StorageUsage.tsx'

// The attachments panel composed for real over a fake Supabase client: the data hooks, the Edge Function
// calls (functions.invoke), the RPCs and the upload queue all run; only the network is replaced.

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  invoke: vi.fn(),
  rpc: vi.fn(),
  prepare: vi.fn(),
}))

vi.mock('../lib/supabase.ts', () => ({
  supabase: {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: h.rows, error: null }).then(ok, bad),
      }
      return q
    },
    rpc: (...args: unknown[]) => h.rpc(...args),
    functions: { invoke: (...args: unknown[]) => h.invoke(...args) },
    channel: () => {
      const c = { on: () => c, subscribe: () => c }
      return c
    },
    removeChannel: async () => {},
  },
}))
vi.mock('../auth/context.ts', () => ({ useAuth: () => ({ status: 'member', user: { id: 'me' }, member: { id: 'me', status: 'active' }, roles: [] }) }))
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({ data: [{ id: 'me', full_name: 'Ana Me' }, { id: 'other', full_name: 'Bo Other' }] }),
}))
vi.mock('./uploads.ts', async () => {
  const { createUploadStore } = await import('./uploadStore.ts')
  return {
    bindUploadsToQueryClient: () => {},
    uploads: createUploadStore(() => ({
      prepare: h.prepare,
      requestUpload: vi.fn(),
      put: vi.fn(),
      confirm: vi.fn(),
      release: vi.fn(async () => {}),
      onUploaded: vi.fn(),
      sleep: async () => {},
    })),
  }
})

const TASK = '11111111-1111-4111-8111-111111111111'

function row(id: string, overrides: Partial<Attachment>): Attachment {
  return {
    id,
    task_id: TASK,
    kind: 'photo',
    original_name: `${id}.webp`,
    mime_type: 'image/webp',
    size_bytes: 345_000,
    width: 2048,
    height: 1536,
    duration_ms: null,
    playable: true,
    caption: null,
    uploaded_by: 'me',
    created_at: '2026-10-08T10:00:00Z',
    ...overrides,
  }
}

const PHOTO = row('photo-1', { caption: 'Front wing' })
const VIDEO = row('video-1', { kind: 'video', original_name: 'run.mp4', mime_type: 'video/mp4', duration_ms: 65_000, uploaded_by: 'other' })
const RAW = row('video-2', { kind: 'video', original_name: 'raw.mov', mime_type: 'video/quicktime', playable: false, uploaded_by: 'other' })
const PDF = row('doc-1', { kind: 'document', original_name: 'quote.pdf', mime_type: 'application/pdf', width: null, height: null })

const MEMBER: AttachmentPermissions = { canUpload: false, canManageAll: false, actorId: 'me' }
const EDITOR: AttachmentPermissions = { canUpload: true, canManageAll: false, actorId: 'me' }
const HEAD: AttachmentPermissions = { canUpload: true, canManageAll: true, actorId: 'me' }

function invokeAnswer(name: string, body: { attachmentIds?: string[]; variant?: string; download?: boolean }) {
  if (name !== 'attachment-download-url') return { data: null, error: new Error('unexpected') }
  const urls = Object.fromEntries((body.attachmentIds ?? []).map((id) => [id, `https://r2.test/${id}/${body.variant}${body.download ? '/dl' : ''}?n=${h.invoke.mock.calls.length}`]))
  return { data: { expiresIn: 3600, urls }, error: null }
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  h.rows = [PHOTO, VIDEO, RAW, PDF]
  h.invoke.mockReset().mockImplementation(async (name: string, { body }: { body: never }) => invokeAnswer(name, body))
  h.rpc.mockReset().mockResolvedValue({ data: true, error: null })
  h.prepare.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('the files panel', () => {
  it('shows one fixed tile per ready file and asks for thumbnails of photos and videos in one batch', async () => {
    render(wrap(<AttachmentsPanel taskId={TASK} perms={MEMBER} />))
    const grid = await screen.findByRole('list', { name: 'Files on this task' })
    expect(within(grid).getAllByRole('button')).toHaveLength(4)
    expect(screen.getByRole('heading', { name: 'Files (4)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open video: run.mp4' })).toHaveTextContent('1:05')
    expect(screen.getByRole('button', { name: 'Open video, download only: raw.mov' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open PDF: quote.pdf' })).toHaveTextContent('quote.pdf')
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('attachment-download-url', { body: { attachmentIds: ['photo-1', 'video-1', 'video-2'], variant: 'thumb', download: false } }),
    )
    // No <video> element until a tile is opened (ATT-11).
    expect(document.querySelector('video')).toBeNull()
    expect(screen.queryByRole('button', { name: /Add photos/ })).toBeNull()
  })

  it('says so when there are no files', async () => {
    h.rows = []
    render(wrap(<AttachmentsPanel taskId={TASK} perms={EDITOR} />))
    expect(await screen.findByText('No files yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add photos, videos or PDFs' })).toBeInTheDocument()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('a picked file appears in the queue with a compress stage and can be cancelled', async () => {
    h.prepare.mockImplementation(
      (_f: File, onProgress: (n: number) => void, signal: AbortSignal) =>
        new Promise((_, reject) => {
          onProgress(0.4)
          signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))
        }),
    )
    render(wrap(<AttachmentsPanel taskId={TASK} perms={EDITOR} />))
    const input = await screen.findByTestId(`task-files-input-${TASK}`)
    fireEvent.change(input, { target: { files: [new File(['v'], 'clip.mov', { type: 'video/quicktime' })] } })
    const bar = await screen.findByRole('progressbar', { name: 'Compressing clip.mov' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByText(/Keep this screen open/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel upload of clip.mov' }))
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss clip.mov' }))
    expect(screen.queryByText('clip.mov')).toBeNull()
  })

  it('shows a load failure with a way to try again', async () => {
    const { supabase } = await import('../lib/supabase.ts')
    const from = vi.spyOn(supabase, 'from').mockImplementationOnce(() => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000', details: '', hint: '' } }).then(ok),
      }
      return q as never
    })
    render(wrap(<AttachmentsPanel taskId={TASK} perms={MEMBER} />))
    expect(await screen.findByText('Could not load the files')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: 'Files on this task' })).toBeInTheDocument()
    from.mockRestore()
  })
})

describe('the lightbox', () => {
  it('opens a photo full size, shows its caption and who added it; the uploader may delete it', async () => {
    render(wrap(<AttachmentsPanel taskId={TASK} perms={EDITOR} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Open photo: photo-1.webp' }))
    const box = screen.getByTestId('attachment-lightbox')
    expect(await within(box).findByTestId('lightbox-photo')).toHaveAttribute('src', expect.stringContaining('photo-1/original'))
    expect(within(box).getByTestId('lightbox-caption')).toHaveTextContent('Front wing')
    expect(within(box).getByText(/added by Ana Me/)).toBeInTheDocument()

    await userEvent.click(within(box).getByTestId('lightbox-delete'))
    await userEvent.click(within(box).getByTestId('lightbox-delete-confirm'))
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('delete_attachment', { p_attachment_id: 'photo-1' }))
    await waitFor(() => expect(screen.queryByTestId('attachment-lightbox')).toBeNull())
  })

  it("another member's file: no delete or caption controls, and the reason", async () => {
    render(wrap(<AttachmentsPanel taskId={TASK} perms={EDITOR} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Open video, download only: raw.mov' }))
    const box = screen.getByTestId('attachment-lightbox')
    expect(within(box).queryByTestId('lightbox-delete')).toBeNull()
    expect(within(box).queryByRole('button', { name: /caption/ })).toBeNull()
    expect(within(box).getByText(/Head or above can delete it/)).toBeInTheDocument()
    expect(within(box).getByText(/stored as the original file/)).toBeInTheDocument()
    expect(box.querySelector('video')).toBeNull()
  })

  it('a Head manages any file: edits a caption', async () => {
    render(wrap(<AttachmentsPanel taskId={TASK} perms={HEAD} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Open video: run.mp4' }))
    const box = screen.getByTestId('attachment-lightbox')
    await userEvent.click(within(box).getByRole('button', { name: 'Add caption' }))
    await userEvent.type(within(box).getByLabelText('Caption'), 'Shakedown lap')
    await userEvent.click(within(box).getByRole('button', { name: 'Save caption' }))
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('set_attachment_caption', { p_attachment_id: 'video-1', p_caption: 'Shakedown lap' }))
  })

  it('downloads through a save-as link and moves between files', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(wrap(<AttachmentsPanel taskId={TASK} perms={MEMBER} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Open PDF: quote.pdf' }))
    const box = screen.getByTestId('attachment-lightbox')
    await userEvent.click(within(box).getByTestId('lightbox-download'))
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('attachment-download-url', { body: { attachmentIds: ['doc-1'], variant: 'original', download: true } }))
    expect(click).toHaveBeenCalled()
    expect(within(box).getByText('4 / 4')).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: 'Next file' })).toBeDisabled()
    await userEvent.click(within(box).getByRole('button', { name: 'Previous file' }))
    expect(within(box).getByText('3 / 4')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'ArrowLeft' })
    expect(within(box).getByText('2 / 4')).toBeInTheDocument()
    await userEvent.click(within(box).getByTestId('lightbox-close'))
    expect(screen.queryByTestId('attachment-lightbox')).toBeNull()
    click.mockRestore()
  })

  it('plays a video in one player; an expired link is replaced and playback resumes where it was', async () => {
    render(wrap(<AttachmentsPanel taskId={TASK} perms={MEMBER} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Open video: run.mp4' }))
    const first = await screen.findByTestId('video-player')
    await waitFor(() => expect(first).toHaveAttribute('src', expect.stringContaining('video-1/original')))
    expect(first).toHaveAttribute('preload', 'metadata')
    expect(first).toHaveAttribute('playsinline')
    expect(document.querySelectorAll('video')).toHaveLength(1)
    const firstSrc = first.getAttribute('src')

    ;(first as HTMLVideoElement).currentTime = 42
    fireEvent.error(first)
    await waitFor(() => expect(screen.getByTestId('video-player').getAttribute('src')).not.toBe(firstSrc))
    const second = screen.getByTestId('video-player') as HTMLVideoElement
    fireEvent.loadedMetadata(second)
    expect(second.currentTime).toBe(42)

    // A fresh link that fails again is a file this browser cannot play.
    fireEvent.error(second)
    expect(await screen.findByTestId('video-failure')).toHaveTextContent('cannot be played in this browser')
  })
})

describe('feature flag and storage usage', () => {
  it('renders nothing while VITE_ATTACHMENTS_ENABLED is off', () => {
    vi.stubEnv('VITE_ATTACHMENTS_ENABLED', '')
    const { container } = render(wrap(<AttachmentsSection taskId={TASK} perms={EDITOR} />))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the panel when it is on', async () => {
    vi.stubEnv('VITE_ATTACHMENTS_ENABLED', 'true')
    render(wrap(<AttachmentsSection taskId={TASK} />))
    expect(await screen.findByRole('list', { name: 'Files on this task' })).toBeInTheDocument()
  })

  it('shows each quota group as a bar', async () => {
    h.rpc.mockResolvedValue({
      data: [
        { quota_group: 'photo_document', used_bytes: 500_000_000, quota_bytes: 2_000_000_000 },
        { quota_group: 'video', used_bytes: 6_500_000_000, quota_bytes: 7_000_000_000 },
      ],
      error: null,
    })
    render(wrap(<StorageUsage />))
    expect(await screen.findByRole('progressbar', { name: 'Videos storage used' })).toHaveAttribute('aria-valuenow', '93')
    expect(screen.getByText('500 MB of 2.00 GB (25%)')).toBeInTheDocument()
    expect(h.rpc).toHaveBeenCalledWith('attachment_usage')
  })

  it('shows a refusal of the usage query', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Only the President, the Vice President or a Developer can see storage usage.', details: '', hint: '' } })
    render(wrap(<StorageUsage />))
    expect(await screen.findByText(/Only the President/)).toBeInTheDocument()
  })
})

