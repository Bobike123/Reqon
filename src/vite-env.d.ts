/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  // 'true' shows task attachments (docs/ultraplan Phase 3); anything else hides them.
  readonly VITE_ATTACHMENTS_ENABLED?: string
  // 'true' shows Settings → Backups (docs/ultraplan Phase 4); anything else hides it.
  readonly VITE_BACKUPS_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
