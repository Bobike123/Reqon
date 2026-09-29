import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Department, ReconciliationPreflightRow } from '../departments/types.ts'
import { DataError } from '../core/errors.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

// The department domain's own row type — see departments/types.ts for why
// this is an alias of the `subteams` table rather than a new hierarchy
// (ADR-0001).
export type Subteam = Department

// The subteam list is structural reference data, not season data. Previously
// lived in useMilestones.ts, which was never the right domain for it — moved
// here (Phase 6 §6.2) so the subteam domain has one owner. Returns every
// department, active and archived: Settings needs both, and downstream
// consumers filter with departments/types.ts's isActive() rather than this
// hook doing it implicitly and silently hiding archived rows everywhere.
export function useSubteams(): UseQueryResult<Department[], Error> {
  return useQuery({
    queryKey: queryKeys.subteams,
    queryFn: async () =>
      unwrap(
        'load subteams',
        await supabase.from('subteams').select('*').order('sort_order'),
      ),
    staleTime: 60 * 60 * 1000,
  })
}

// Whether the signed-in caller may configure departments (create, rename,
// describe, appoint Head, reorder, archive, restore, reconcile) — a mirror
// of can_manage_departments() (20260115000000), used only to distinguish
// "the write was refused because of who I am" from "the row disappeared out
// from under me" after a zero-row UPDATE. It is never treated as authority;
// the database re-checks every one of these calls itself.
async function canManageDepartments(): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_manage_departments')
  if (error) throw new DataError('check whether the change was saved', error)
  return data === true
}

export type DepartmentEdit = {
  key: string
  name?: string
  description?: string | null
  leadId?: string | null
  // Competition meaning only ("these rules only bite at the Final Event");
  // independent of archiving. Same department_update policy as the rest.
  isParked?: boolean
}

// Rename, describe, appoint/change Head, park/unpark. Archive/restore/create/reorder are
// separate commands below — the field-level split the execution contract
// asks for ("structural metadata... are separate commands"), not because
// the underlying table differs.
export function useUpdateSubteam() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DepartmentEdit>({
    mutationFn: async (edit) => {
      const { data, error } = await supabase
        .from('subteams')
        .update({
          ...(edit.name !== undefined ? { name: edit.name } : {}),
          ...(edit.description !== undefined ? { description: edit.description } : {}),
          // The key is never touched: clauses reference subteams by key, and
          // renaming the key would orphan 1,146 rows.
          ...(edit.leadId !== undefined ? { lead_id: edit.leadId } : {}),
          ...(edit.isParked !== undefined ? { is_parked: edit.isParked } : {}),
        })
        .eq('key', edit.key)
        .select('key')
      if (error) throw new DataError('edit that department', error)
      if (data && data.length > 0) return
      if (await canManageDepartments()) {
        throw new DataError('save that department: it no longer exists', null)
      }
      throw new DataError('edit that department', null, { permission: true })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}

export type CreateDepartment = { key: string; name: string; description?: string | null }

// Creating is an INSERT, so a refusal — no privilege (RLS WITH CHECK), the
// 10-active cap, or an invalid key collision — raises a real Postgres error
// rather than matching zero rows; DataError already tells a permission
// refusal apart from a domain error by inspecting that error's own code and
// message (core/errors.ts), so no cap-specific handling belongs here. A new
// department never invents a rulebook section (source §1); book_section
// stays null until reconciliation or a maintenance script sets it.
export function useCreateDepartment() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, CreateDepartment>({
    mutationFn: async ({ key, name, description }) => {
      const { error } = await supabase
        .from('subteams')
        .insert({ key, name, description: description ?? null, book_section: null })
      if (error) throw new DataError('create that department', error)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}

export type ArchiveDepartment = { key: string; reason: string }

export function useArchiveDepartment() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, ArchiveDepartment>({
    mutationFn: async ({ key, reason }) => {
      const { data, error } = await supabase
        .from('subteams')
        .update({ archived_at: new Date().toISOString(), archive_reason: reason })
        .eq('key', key)
        .select('key')
      // A stranded-work refusal (guard_department_archive) is a real raised
      // error, not a zero-row match — it surfaces here exactly as thrown.
      if (error) throw new DataError('archive that department', error)
      if (data && data.length > 0) return
      if (await canManageDepartments()) {
        throw new DataError('archive that department: it no longer exists', null)
      }
      throw new DataError('archive that department', null, { permission: true })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}

export function useRestoreDepartment() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { key: string }>({
    mutationFn: async ({ key }) => {
      const { data, error } = await supabase
        .from('subteams')
        .update({ archived_at: null, archived_by: null, archive_reason: null })
        .eq('key', key)
        .select('key')
      // The 10-active cap (enforce_department_cap) also surfaces here as a
      // real raised error — restoring past the cap is refused identically
      // to creating past it.
      if (error) throw new DataError('restore that department', error)
      if (data && data.length > 0) return
      if (await canManageDepartments()) {
        throw new DataError('restore that department: it no longer exists', null)
      }
      throw new DataError('restore that department', null, { permission: true })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}

// Accessible reorder (Move up/Move down build the next full ordered key
// list from what is already on screen and send it here in one call) rather
// than N individually racy per-row updates — reorder_departments()
// (20260115000000) assigns sort_order = position atomically.
export function useReorderDepartments() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, readonly string[]>({
    mutationFn: async (orderedKeys) => {
      const { error } = await supabase.rpc('reorder_departments', {
        p_ordered_keys: [...orderedKeys],
      })
      if (error) throw new DataError('reorder departments', error)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}

export type ReconciliationManifest = {
  label: string
  purpose: 'production' | 'test_fixture'
  departments: {
    key: string
    action: 'keep' | 'rename' | 'archive' | 'create'
    name?: string
    reason?: string
    sort_order?: number
  }[]
}

// Read-only preview of a reconciliation manifest (docs/redesign/
// DEPARTMENT_RECONCILIATION.md). Not wired into any Phase 1 screen — the
// production manifest is a maintenance operation the President/Developer
// run outside the day-to-day UI (blocked on a user-reviewed manifest, see
// STATUS.md X1) — but the typed call exists now so a maintenance script or
// a later admin screen has one reviewed entry point rather than each
// inventing its own RPC call shape.
export function useReconciliationPreflight() {
  return useMutation<ReconciliationPreflightRow[], Error, ReconciliationManifest>({
    mutationFn: async (manifest) =>
      unwrap('preview a reconciliation manifest', await supabase.rpc('reconciliation_preflight', {
        p_manifest: manifest,
      })),
  })
}

export function useApplyReconciliation() {
  const queryClient = useQueryClient()
  return useMutation<{ applied: boolean; active_count: number; label: string }, Error, ReconciliationManifest>({
    mutationFn: async (manifest) =>
      unwrap('apply a reconciliation manifest', await supabase.rpc('reconciliation_apply', {
        p_manifest: manifest,
      })) as unknown as { applied: boolean; active_count: number; label: string },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
    },
  })
}
