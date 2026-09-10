import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// The Supabase client reads these at import time and throws without them.
// Tests never reach the network — the client module is mocked per test file.
vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
