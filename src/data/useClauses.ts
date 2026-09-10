import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { fetchAllRows } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type Clause = Database['public']['Tables']['clauses']['Row']

// The regulations book: 1,146 clauses, imported once per edition. This is
// reference data, NOT team data — it has no season_id and must not be filtered
// by season. A new season reads the same book.
//
// Progress against a clause lives in clause_status (see useClauseStatus.ts).
// Never write to this table to record what the team did.
export function useClauses(): UseQueryResult<Clause[], Error> {
  return useQuery({
    queryKey: queryKeys.clauses,
    // Paged, because there are more clauses than one Supabase response may
    // return. See fetchAllRows for why a plain .select() loses 146 of them.
    queryFn: () =>
      fetchAllRows('load clauses', (from, to) =>
        supabase
          .from('clauses')
          .select('*')
          .order('section')
          .order('article')
          .order('clause_key')
          .range(from, to),
      ),
    // The book does not change during a session. Re-reading 1,146 rows on every
    // window focus would be the single most expensive thing the app does.
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
  })
}
