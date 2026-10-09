import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { supabase } from '../lib/supabase.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { invoke } from './useAttachments.ts'

// What the backup workflow recorded (docs/ultraplan Phase 4). The table is readable by the President, the
// Vice President and Developers only (RLS is_admin()); nobody writes it from the browser — the workflow
// does, through the backup-record Edge Function.

export type BackupRun = Pick<
  Database['public']['Tables']['backup_runs']['Row'],
  'id' | 'destination' | 'taken_at' | 'ok' | 'object_key' | 'size_bytes' | 'sha256' | 'migration_version' | 'db_size_bytes' | 'row_count' | 'recipients' | 'detail'
>

const COLUMNS = 'id, destination, taken_at, ok, object_key, size_bytes, sha256, migration_version, db_size_bytes, row_count, recipients, detail'

// Newest first; 60 rows cover more than the last month of three destinations.
export function useBackupRuns(): UseQueryResult<BackupRun[], Error> {
  return useQuery({
    queryKey: queryKeys.backupRuns,
    queryFn: async () =>
      unwrap(
        'load the backup status',
        await supabase.from('backup_runs').select(COLUMNS).order('taken_at', { ascending: false }).order('id', { ascending: false }).limit(60),
      ),
    // A backup lands once a day; the panel is looked at rarely. Re-read when the tab comes back, not constantly.
    staleTime: 60_000,
  })
}

export type BackupDownload = { url: string; expiresIn: number; name: string; sizeBytes: number; sha256: string; takenAt: string }

// A short-lived link to the newest backup in R2 (the file is age-encrypted; the link alone discloses nothing).
export function requestBackupDownload(): Promise<BackupDownload> {
  return invoke<BackupDownload>('backup-download-url', {}, 'download the backup')
}
