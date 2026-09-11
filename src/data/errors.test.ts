import type { PostgrestError } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { DataError, isPermissionError } from './errors.ts'

// The shape supabase-js hands back; only message and code matter here.
const pgError = (message: string, code: string) =>
  ({ message, code, details: '', hint: '', name: 'PostgrestError', toJSON: () => ({}) }) as unknown as PostgrestError

const RLS_MESSAGE = 'new row violates row-level security policy for table "members"'
const rls = pgError(RLS_MESSAGE, '42501')

describe('refusals are worded for people', () => {
  it('replaces the Postgres wording of an RLS refusal', () => {
    const error = new DataError('add people to the roster', rls)
    expect(error.permission).toBe(true)
    expect(error.message).toBe(
      "You don't have permission to add people to the roster. Nothing was changed. Ask the President if you need this.",
    )
  })

  it('keeps a refusal the database explained itself', () => {
    const error = new DataError(
      'take away the President role',
      pgError('The club must always have a president. Give the role to someone else first, then remove it here.', '42501'),
    )
    expect(error.permission).toBe(true)
    expect(error.message).toMatch(/^The club must always have a president/)
  })

  it('does not call an ordinary failure a permission problem', () => {
    const error = new DataError('create a season', pgError('duplicate key value', '23505'))
    expect(error.permission).toBe(false)
    expect(error.message).toBe('create a season: duplicate key value')
  })

  it('recognises a refusal however deeply it was wrapped', () => {
    const inner = new DataError('give the Developer role', rls)
    expect(isPermissionError(new Error('outer', { cause: new Error('middle', { cause: inner }) }))).toBe(true)
    expect(isPermissionError(new Error('network down'))).toBe(false)
  })
})
