import type { UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, fetchAllRows } from './errors.ts'
import { useOptimisticListMutation } from './optimistic.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type ClauseStatus = Database['public']['Tables']['clause_status']['Row']
export type ClauseState = Database['public']['Enums']['clause_state']

// What the team did about each rule, this season. Season-scoped: a new season
// starts with this table empty and the rulebook untouched.
export function useClauseStatus() {
  return useSeasonScopedQuery<ClauseStatus[]>('clause_status', (seasonId) =>
    fetchAllRows('load clause status', (from, to) =>
      supabase
        .from('clause_status')
        .select('*')
        .eq('season_id', seasonId)
        .range(from, to),
    ),
  ) as UseQueryResult<ClauseStatus[], Error> & { seasonId: string | undefined }
}

export type ClauseStatusEdit = {
  clauseKey: string
  state?: ClauseState
  ownerId?: string | null
  evidence?: string | null
  starred?: boolean
}

// One row per (season, clause), so writes are an upsert on that pair rather
// than an insert-or-update dance in the client.
export function useSetClauseStatus() {
  const auth = useAuth()
  const { seasonId } = useClauseStatus()

  return useOptimisticListMutation<ClauseStatus, ClauseStatusEdit>({
    entity: 'clause_status',
    seasonId,

    write: async (edit) => {
      if (auth.status !== 'member') {
        throw new DataError('save clause status: not signed in as a member', null)
      }
      if (!seasonId) {
        throw new DataError('save clause status: no current season', null)
      }

      const { error } = await supabase.from('clause_status').upsert(
        {
          season_id: seasonId,
          clause_key: edit.clauseKey,
          ...(edit.state !== undefined ? { state: edit.state } : {}),
          ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
          ...(edit.evidence !== undefined ? { evidence: edit.evidence } : {}),
          ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
          // Who touched it. The audit trail is the whole point of having
          // accounts instead of one shared password.
          updated_by: auth.member.id,
        },
        { onConflict: 'season_id,clause_key' },
      )
      if (error) throw new DataError('save clause status', error)
    },

    apply: (rows, edit) => {
      const index = rows.findIndex((row) => row.clause_key === edit.clauseKey)
      const patch = {
        ...(edit.state !== undefined ? { state: edit.state } : {}),
        ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
        ...(edit.evidence !== undefined ? { evidence: edit.evidence } : {}),
        ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
      }
      if (index === -1) return rows
      return rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
    },
  })
}
