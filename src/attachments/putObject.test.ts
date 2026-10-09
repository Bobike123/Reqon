import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdScreenAwake } from './media/wakeLock.ts'
import { PutError, putObject } from './putObject.ts'

class FakeXhr {
  static last: FakeXhr
  method = ''
  url = ''
  headers: Record<string, string> = {}
  status = 0
  body: unknown = null
  aborted = false
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('putObject', () => {
  it('PUTs the body with exactly the signed headers and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const progress: number[] = []
    const body = new Blob(['abc'])
    const done = putObject({ url: 'https://r2/x', headers: { 'Content-Type': 'image/webp' } }, body, { onProgress: (f) => progress.push(f) })
    const xhr = FakeXhr.last
    expect(xhr).toMatchObject({ method: 'PUT', url: 'https://r2/x', headers: { 'Content-Type': 'image/webp' }, body })
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 })
    xhr.status = 200
    xhr.onload?.()
    await done
    expect(progress).toEqual([0.25, 1])
  })

  it('names an expired signature, a refusal and a dropped connection', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    for (const [status, text] of [
      [403, 'expired'],
      [500, 'error 500'],
    ] as const) {
      const p = putObject({ url: 'u', headers: {} }, new Blob(['a']))
      FakeXhr.last.status = status
      FakeXhr.last.onload?.()
      await expect(p).rejects.toThrow(text)
    }
    const p = putObject({ url: 'u', headers: {} }, new Blob(['a']))
    FakeXhr.last.onerror?.()
    await expect(p).rejects.toBeInstanceOf(PutError)
  })

  it('aborts with the signal, and refuses to start when already aborted', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const controller = new AbortController()
    const p = putObject({ url: 'u', headers: {} }, new Blob(['a']), { signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeXhr.last.aborted).toBe(true)
    await expect(putObject({ url: 'u', headers: {} }, new Blob(['a']), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('holdScreenAwake', () => {
  it('does nothing without the Wake Lock API', () => {
    expect(() => holdScreenAwake()()).not.toThrow()
  })

  it('takes the lock, takes it again when the page returns, and releases it', async () => {
    const release = vi.fn(async () => {})
    const request = vi.fn(async () => ({ release }))
    vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })
    const stop = holdScreenAwake()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    stop()
    expect(release).toHaveBeenCalled()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(request).toHaveBeenCalledTimes(2)
  })
})
