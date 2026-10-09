// The Backups panel in Settings is off unless the build sets VITE_BACKUPS_ENABLED=true (Ultraplan Phase 4).
// The hosted database only gets the backup_runs table in Phase 7; until then the panel would show an error.
export function backupsEnabled(env: { VITE_BACKUPS_ENABLED?: string } = import.meta.env): boolean {
  return env.VITE_BACKUPS_ENABLED === 'true'
}
