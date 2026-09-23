import type { PostgrestError } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { DataError, isPermissionError } from '../core/errors.ts'
import { fetchAllRows } from './errors.ts'

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

// A fake PostgREST: honours .range(from, to) like the real server, and can
// cap every response below what was requested — exactly what max_rows in
// supabase/config.toml does when it is lower than fetchAllRows's own request
// size. `cap` defaults to unlimited (bounded only by the requested width).
type Row = { id: number }

function makeServer(total: number, cap = Infinity) {
  const rows: Row[] = Array.from({ length: total }, (_, i) => ({ id: i + 1 }))
  const calls: [number, number][] = []
  const page = async (from: number, to: number) => {
    calls.push([from, to])
    const width = Math.min(to - from + 1, cap)
    return { data: rows.slice(from, from + width), error: null }
  }
  return { page, calls, rows }
}

const byId = (row: Row) => row.id

describe('fetchAllRows', () => {
  it('returns every row of a small, single-page collection, in the order given', async () => {
    const server = makeServer(25)
    const result = await fetchAllRows('load x', byId, server.page)
    expect(result.map(byId)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
  })

  it('pages fully through 1,146 rows when the server caps every request at 500', async () => {
    const server = makeServer(1146, 500)
    const result = await fetchAllRows('load clauses', byId, server.page)
    expect(result).toHaveLength(1146)
    expect(result[0].id).toBe(1)
    expect(result[1145].id).toBe(1146)
    // 500 + 500 + 146, then one empty page confirms the end — a short page is
    // NOT itself proof there is nothing left, since the cap (500) is below
    // what was requested (1000) on every call.
    expect(server.calls).toEqual([[0, 999], [500, 1499], [1000, 1999], [1146, 2145]])
  })

  it('terminates only after an empty page on an exact page-size multiple', async () => {
    const server = makeServer(2000)
    const result = await fetchAllRows('load x', byId, server.page)
    expect(result).toHaveLength(2000)
    expect(server.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('handles one row over the page size correctly', async () => {
    const server = makeServer(1001)
    const result = await fetchAllRows('load x', byId, server.page)
    expect(result).toHaveLength(1001)
    expect(server.calls).toEqual([[0, 999], [1000, 1999], [1001, 2000]])
  })

  it('drops a row that reappears on the next page because of a concurrent insert', async () => {
    // A row inserted earlier in sort order than the current offset shifts
    // every later row down one place, so whatever was last on a page can
    // legitimately reappear first on the next one.
    const server = makeServer(1200)
    let insertedOnce = false
    const page = async (from: number, to: number) => {
      if (from === 1000 && !insertedOnce) {
        insertedOnce = true
        server.rows.splice(999, 0, { id: 0 }) // a genuinely new row, sorted before the boundary
      }
      const { data } = await server.page(from, to)
      return { data, error: null }
    }
    const result = await fetchAllRows('load x', byId, page)
    const ids = result.map(byId)
    expect(ids.length).toBe(new Set(ids).size) // no id appears twice
    // Every one of the original 1,200 rows is still present exactly once.
    for (let id = 1; id <= 1200; id += 1) expect(ids).toContain(id)
  })

  it('counts a row seen twice across pages once, not twice', async () => {
    let call = 0
    const page = async () => {
      call += 1
      if (call === 1) return { data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null }
      if (call === 2) return { data: [{ id: 3 }, { id: 4 }], error: null } // id 3 repeats
      return { data: [], error: null }
    }
    const result = await fetchAllRows('load x', byId, page)
    expect(result.map(byId)).toEqual([1, 2, 3, 4])
  })

  it('skips nothing in an ordinary, non-adversarial fetch', async () => {
    const server = makeServer(250)
    const result = await fetchAllRows('load x', byId, server.page)
    expect(result.map(byId)).toEqual(server.rows.map(byId))
  })

  it('refuses to loop forever against a server that never returns an empty page', async () => {
    let call = 0
    const page = async (from: number) => {
      call += 1
      return { data: [{ id: from }], error: null } // always exactly one row, never empty
    }
    await expect(fetchAllRows('load x', byId, page)).rejects.toThrow(/still more rows after 50 requests/)
    expect(call).toBe(50)
  })
})
