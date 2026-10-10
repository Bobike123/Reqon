import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { PostgrestError } from '@supabase/supabase-js'
import { DataError } from '../core/errors.ts'
import type { Database } from '../lib/database.types.ts'
import { supabase } from '../lib/supabase.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type ContactCategory = Database['public']['Tables']['contact_categories']['Row']
export type Contact = Database['public']['Tables']['contacts']['Row']
export type ContactDirectory = { categories: ContactCategory[]; contacts: Contact[] }

export type CategoryInput = { name: string; description: string | null }
export type ContactInput = Pick<Contact, 'category_id' | 'name' | 'title' | 'help' | 'email' | 'phone' | 'website'>

// The whole directory in one read: it is small (tens of rows), and the screen
// always needs both halves. Every member may read it (contacts_read).
export function useContactDirectory(): UseQueryResult<ContactDirectory, Error> {
  return useQuery({
    queryKey: queryKeys.contacts,
    queryFn: async () => {
      const [categories, contacts] = await Promise.all([
        supabase.from('contact_categories').select('*').order('name'),
        supabase.from('contacts').select('*').order('name'),
      ])
      return {
        categories: unwrap('load contact categories', categories),
        contacts: unwrap('load contacts', contacts),
      }
    },
  })
}

// A write RLS refuses as an UPDATE or DELETE matches no row instead of
// failing, so "nothing changed" is reported rather than shown as success.
function fail(what: string, error: PostgrestError | null): never {
  if (error?.code === '23505') throw new DataError('A category with that name already exists. Pick another name.', null)
  if (error?.code === '23514') throw new DataError('Check the email, phone number and website: one of them is not in a form that can be used.', null)
  throw new DataError(what, error, error ? {} : { permission: true })
}

function useWrite<T>(what: string, write: (input: T) => PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>) {
  const queryClient = useQueryClient()
  return useMutation<void, Error, T>({
    mutationFn: async (input) => {
      const { data, error } = await write(input)
      if (error || !data || data.length === 0) fail(what, error)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts }),
  })
}

export function useSaveCategory() {
  return useWrite<CategoryInput & { id?: string }>('save that category', ({ id, ...row }) =>
    id
      ? supabase.from('contact_categories').update(row).eq('id', id).select('id')
      : supabase.from('contact_categories').insert(row).select('id'),
  )
}

export function useDeleteCategory() {
  return useWrite<string>('delete that category', (id) => supabase.from('contact_categories').delete().eq('id', id).select('id'))
}

export function useSaveContact() {
  return useWrite<ContactInput & { id?: string }>('save that contact', ({ id, ...row }) =>
    id
      ? supabase.from('contacts').update(row).eq('id', id).select('id')
      : supabase.from('contacts').insert(row).select('id'),
  )
}

export function useDeleteContact() {
  return useWrite<string>('delete that contact', (id) => supabase.from('contacts').delete().eq('id', id).select('id'))
}
