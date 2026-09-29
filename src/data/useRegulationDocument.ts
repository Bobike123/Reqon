import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { DataError } from '../core/errors.ts'
import { documentSource } from '../book/source.ts'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { unwrapMaybe } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type RegulationDocument = Database['public']['Tables']['regulation_documents']['Row']

// The document a regulations edition (seasons.regs_ref) reads. Reference data:
// one row per edition, managed by administrators, readable by every member.
// `null` is a real answer — nothing has been configured for this edition yet —
// and is not an error.
export function useRegulationDocument(regsRef: string | null | undefined): UseQueryResult<RegulationDocument | null, Error> {
  return useQuery({
    queryKey: queryKeys.regulationDocument(regsRef),
    enabled: Boolean(regsRef),
    queryFn: async () =>
      unwrapMaybe(
        'load the Requirements Book source',
        await supabase.from('regulation_documents').select('*').eq('regs_ref', regsRef as string).maybeSingle(),
      ),
    staleTime: 5 * 60 * 1000,
  })
}

export type BookFile =
  // Nothing configured.
  | { status: 'none' }
  // Configured, but the stored value is not something we will open.
  | { status: 'invalid'; reason: string }
  // A link the browser can open. `external` marks a third-party host.
  | { status: 'ready'; url: string; external: boolean }

const SIGNED_URL_SECONDS = 300

// Turns the configured source into something the browser can open. An https
// link is used as is. A file in the private bucket gets a SHORT-LIVED signed
// link, requested here through the signed-in session (so the bucket's own
// policy decides who may read it) and never stored anywhere.
export function useBookFile(
  doc: RegulationDocument | null | undefined,
): { data: BookFile | undefined; isLoading: boolean; error: Error | null } {
  const auth = useAuth()
  const source = documentSource(doc)
  const isStorage = source.kind === 'storage'

  const signed = useQuery({
    queryKey: queryKeys.bookFile(doc?.regs_ref ?? '', isStorage ? source.path : ''),
    enabled: isStorage && auth.status === 'member',
    queryFn: async () => {
      if (source.kind !== 'storage') throw new DataError('open the Requirements Book: no stored file', null)
      const { data, error } = await supabase.storage.from('regulations').createSignedUrl(source.path, SIGNED_URL_SECONDS)
      if (error || !data?.signedUrl) throw new DataError(`open the Requirements Book file${error ? `: ${error.message}` : ''}`, null)
      return data.signedUrl
    },
    // Re-signed a little before it expires, and only while a screen is using it.
    staleTime: (SIGNED_URL_SECONDS - 60) * 1000,
    gcTime: 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  })

  if (doc === undefined) return { data: undefined, isLoading: true, error: null }
  if (source.kind === 'none') return { data: { status: 'none' }, isLoading: false, error: null }
  if (source.kind === 'invalid') return { data: { status: 'invalid', reason: source.reason }, isLoading: false, error: null }
  if (source.kind === 'url') return { data: { status: 'ready', url: source.url, external: true }, isLoading: false, error: null }
  if (signed.data) return { data: { status: 'ready', url: signed.data, external: false }, isLoading: false, error: null }
  return { data: undefined, isLoading: signed.isLoading, error: signed.error }
}

export type RegulationDocumentEdit = {
  regsRef: string
  edition: string | null
  title: string | null
  url: string | null
  storagePath: string | null
  pageOffset: number
  pageCount: number | null
}

// Administrators only — the database refuses everyone else (regulation_documents
// has an is_admin() write policy), and that refusal is shown, not swallowed.
// The editor and the time are stamped by the server, never sent from here.
export function useSaveRegulationDocument() {
  const queryClient = useQueryClient()
  return useMutation<RegulationDocument, Error, RegulationDocumentEdit>({
    mutationFn: async (edit) => {
      const { data, error } = await supabase
        .from('regulation_documents')
        .upsert(
          {
            regs_ref: edit.regsRef,
            edition: edit.edition,
            title: edit.title,
            url: edit.url,
            storage_path: edit.storagePath,
            page_offset: edit.pageOffset,
            page_count: edit.pageCount,
          },
          { onConflict: 'regs_ref' },
        )
        .select()
        .single()
      if (error) throw new DataError('save the Requirements Book source', error)
      return data
    },
    onSuccess: (_row, edit) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.regulationDocument(edit.regsRef) })
      // A new location invalidates any link signed for the old one.
      void queryClient.invalidateQueries({ queryKey: ['book_file'] })
    },
  })
}
