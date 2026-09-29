import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Requirements Book source hooks against a fake Supabase client: which rows
// are read, that a private file is signed on demand for a short time and never
// stored, and that a database refusal reaches the caller as a permission error.

type Row = {
  regs_ref: string
  edition: string | null
  title: string | null
  updated_by: string | null
  url: string | null
  storage_path: string | null
  page_offset: number
  page_count: number | null
  updated_at: string
}
const fake = {
  doc: null as Row | null,
  docError: null as { code?: string; message: string } | null,
  signed: { data: { signedUrl: 'https://project.supabase.co/sign/x?token=abc' }, error: null } as {
    data: { signedUrl: string } | null
    error: { message: string } | null
  },
  signCalls: [] as { bucket: string; path: string; seconds: number }[],
  eqCalls: [] as [string, string][],
  upserts: [] as { row: Record<string, unknown>; options: unknown }[],
  upsertError: null as { code?: string; message: string } | null,
}

vi.mock('../auth/context.ts', () => ({ useAuth: () => ({ status: 'member', user: { id: 'me' }, member: { id: 'me' } }) }))
vi.mock('../lib/supabase.ts', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (column: string, value: string) => {
          fake.eqCalls.push([column, value])
          return { maybeSingle: async () => ({ data: fake.doc, error: fake.docError }) }
        },
      }),
      upsert: (row: Record<string, unknown>, options: unknown) => {
        fake.upserts.push({ row, options })
        return {
          select: () => ({
            single: async () => (fake.upsertError ? { data: null, error: fake.upsertError } : { data: { ...row, updated_at: 'now' }, error: null }),
          }),
        }
      },
    }),
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, seconds: number) => {
          fake.signCalls.push({ bucket, path, seconds })
          return fake.signed
        },
      }),
    },
  },
}))

const { useBookFile, useRegulationDocument, useSaveRegulationDocument } = await import('./useRegulationDocument.ts')

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const row = (over: Partial<Row> = {}): Row => ({
  regs_ref: 'ED1', edition: null, title: null, updated_by: null, url: null, storage_path: null, page_offset: 0, page_count: null, updated_at: 't', ...over,
})

beforeEach(() => {
  fake.doc = null
  fake.docError = null
  fake.signed = { data: { signedUrl: 'https://project.supabase.co/sign/x?token=abc' }, error: null }
  fake.signCalls = []
  fake.eqCalls = []
  fake.upserts = []
  fake.upsertError = null
})

describe('useRegulationDocument', () => {
  it('reads the row for the season\'s edition, and null when none is configured', async () => {
    const { result } = renderHook(() => useRegulationDocument('ED1'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
    expect(fake.eqCalls).toEqual([['regs_ref', 'ED1']])
  })

  it('does not query at all without an edition', () => {
    renderHook(() => useRegulationDocument(null), { wrapper: wrapper() })
    expect(fake.eqCalls).toEqual([])
  })

  it('surfaces a read failure', async () => {
    fake.docError = { message: 'boom' }
    const { result } = renderHook(() => useRegulationDocument('ED1'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toMatch(/load the Requirements Book source/)
  })
})

describe('useBookFile', () => {
  it('is loading until the document row has arrived', () => {
    const { result } = renderHook(() => useBookFile(undefined), { wrapper: wrapper() })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.data).toBeUndefined()
  })

  it('reports "none" when nothing is configured, and never signs anything', () => {
    const { result: none } = renderHook(() => useBookFile(null), { wrapper: wrapper() })
    expect(none.current.data).toEqual({ status: 'none' })
    const { result: empty } = renderHook(() => useBookFile(row()), { wrapper: wrapper() })
    expect(empty.current.data).toEqual({ status: 'none' })
    expect(fake.signCalls).toEqual([])
  })

  it('uses an https link as it is, marked external, without signing', () => {
    const { result } = renderHook(() => useBookFile(row({ url: 'https://example.org/regs.pdf' })), { wrapper: wrapper() })
    expect(result.current.data).toEqual({ status: 'ready', url: 'https://example.org/regs.pdf', external: true })
    expect(fake.signCalls).toEqual([])
  })

  it('will not open a stored value that fails validation', () => {
    const { result } = renderHook(() => useBookFile(row({ url: 'javascript:alert(1)' })), { wrapper: wrapper() })
    expect(result.current.data?.status).toBe('invalid')
    expect(fake.signCalls).toEqual([])
  })

  it('asks the private bucket for a SHORT-LIVED link through the session, and marks it internal', async () => {
    const { result } = renderHook(() => useBookFile(row({ storage_path: 'ms2627/regs.pdf' })), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.status).toBe('ready'))
    expect(result.current.data).toEqual({ status: 'ready', url: 'https://project.supabase.co/sign/x?token=abc', external: false })
    expect(fake.signCalls).toEqual([{ bucket: 'regulations', path: 'ms2627/regs.pdf', seconds: 300 }])
  })

  it('reports an unreachable stored file as an error, not as "not configured"', async () => {
    fake.signed = { data: null, error: { message: 'Object not found' } }
    const { result } = renderHook(() => useBookFile(row({ storage_path: 'gone.pdf' })), { wrapper: wrapper() })
    // The hook retries a failed signing once before giving up (about a second).
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 4000 })
    expect(result.current.error?.message).toMatch(/Object not found/)
    expect(result.current.data).toBeUndefined()
  })
})

describe('useSaveRegulationDocument', () => {
  const edit = {
    regsRef: 'ED1', edition: 'Ed', title: 'Regs', url: 'https://example.org/a.pdf', storagePath: null, pageOffset: 2, pageCount: 300,
  }

  it('upserts on regs_ref and never sends the editor or the time', async () => {
    const { result } = renderHook(() => useSaveRegulationDocument(), { wrapper: wrapper() })
    await result.current.mutateAsync(edit)
    expect(fake.upserts).toHaveLength(1)
    expect(fake.upserts[0].options).toEqual({ onConflict: 'regs_ref' })
    expect(fake.upserts[0].row).toEqual({
      regs_ref: 'ED1', edition: 'Ed', title: 'Regs', url: 'https://example.org/a.pdf', storage_path: null, page_offset: 2, page_count: 300,
    })
    expect(fake.upserts[0].row).not.toHaveProperty('updated_by')
    expect(fake.upserts[0].row).not.toHaveProperty('updated_at')
  })

  it('shows a database refusal as a permission error, not a silent success', async () => {
    fake.upsertError = { code: '42501', message: 'new row violates row-level security policy for table "regulation_documents"' }
    const { result } = renderHook(() => useSaveRegulationDocument(), { wrapper: wrapper() })
    await expect(result.current.mutateAsync(edit)).rejects.toMatchObject({ permission: true })
  })
})
