import { describe, expect, it } from 'vitest'
import { parseCopyHeader, readIdent } from './stage.mjs'

// The COPY header parser of the staging converter (Ultraplan Phase 5): getting a table or column name
// wrong would stage rows under the wrong name, so every quoting form pg_dump produces is pinned here.
describe('stage.mjs COPY headers', () => {
  it('reads plain headers', () => {
    expect(parseCopyHeader('COPY public.tasks (id, title, state) FROM stdin;')).toEqual({ schema: 'public', table: 'tasks', columns: ['id', 'title', 'state'] })
  })
  it('reads quoted identifiers, including reserved words and doubled quotes', () => {
    expect(parseCopyHeader('COPY public."order" ("from", "we""ird", plain) FROM stdin;')).toEqual({
      schema: 'public', table: 'order', columns: ['from', 'we"ird', 'plain'],
    })
    expect(parseCopyHeader('COPY "Odd Schema"."My, Table" ("a b", "c,d") FROM stdin;')).toEqual({
      schema: 'Odd Schema', table: 'My, Table', columns: ['a b', 'c,d'],
    })
  })
  it('reads the auth and migration tables', () => {
    expect(parseCopyHeader('COPY auth.users (instance_id, id, aud) FROM stdin;')?.table).toBe('users')
    expect(parseCopyHeader('COPY supabase_migrations.schema_migrations (version, statements, name) FROM stdin;')?.schema).toBe('supabase_migrations')
  })
  it('ignores every other line', () => {
    expect(parseCopyHeader('SET statement_timeout = 0;')).toBeNull()
    expect(parseCopyHeader("SELECT pg_catalog.setval('public.x_seq', 4, true);")).toBeNull()
    expect(parseCopyHeader('COPY public.tasks (id) FROM stdin')).toBeNull()
  })
  it('refuses malformed headers instead of guessing', () => {
    expect(() => parseCopyHeader('COPY tasks (id) FROM stdin;')).toThrow('schema.table')
    expect(() => parseCopyHeader('COPY public.tasks id FROM stdin;')).toThrow('column list')
    expect(() => parseCopyHeader('COPY public."tasks (id) FROM stdin;')).toThrow()
    expect(() => readIdent('9abc', 0)).toThrow('not an identifier')
  })
})
