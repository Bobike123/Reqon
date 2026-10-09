// Task attachments are off unless the build sets VITE_ATTACHMENTS_ENABLED=true (Ultraplan Phase 3,
// requirement ATT-15). Off hides every attachment control; the database tables and Edge Functions can
// exist without any screen using them.
export function attachmentsEnabled(env: { VITE_ATTACHMENTS_ENABLED?: string } = import.meta.env): boolean {
  return env.VITE_ATTACHMENTS_ENABLED === 'true'
}
