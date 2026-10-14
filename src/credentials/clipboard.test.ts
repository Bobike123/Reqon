import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from './clipboard.ts'

type Item = { items: Record<string, Promise<Blob>> }

// A stand-in for the browser's ClipboardItem: it only needs to keep what it was given.
class FakeClipboardItem {
  items: Record<string, Promise<Blob>>
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items
  }
}

const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true })

beforeEach(() => setClipboard(undefined))
afterEach(() => {
  setClipboard(undefined)
  vi.unstubAllGlobals()
})

describe('copyToClipboard', () => {
  it('writes plain text with writeText when ClipboardItem does not exist', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })
    await copyToClipboard('login@example.test')
    expect(writeText).toHaveBeenCalledExactlyOnceWith('login@example.test')
  })

  it('waits for a promised text before using writeText when ClipboardItem does not exist', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })
    await copyToClipboard(Promise.resolve('from-the-server'))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('from-the-server')
  })

  it('hands a promised text to the clipboard at once when ClipboardItem exists (the Safari rule)', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    let release: (text: string) => void = () => {}
    const pending = new Promise<string>((resolve) => (release = resolve))
    let written = ''
    const write = vi.fn(async (items: Item[]) => {
      written = await (await items[0].items['text/plain']).text()
    })
    setClipboard({ write, writeText: vi.fn() })

    const copying = copyToClipboard(pending)
    // write() was called BEFORE the text arrived: that is what keeps the tap's permission alive.
    expect(write).toHaveBeenCalledTimes(1)
    release('Fixture-pw-1')
    await copying
    expect(written).toBe('Fixture-pw-1')
  })

  it('reports the real reason when the text could not be fetched, not the browser’s own refusal', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    const write = vi.fn(async (items: Item[]) => {
      try {
        await items[0].items['text/plain']
      } catch {
        throw new Error('NotAllowedError: the browser’s generic refusal')
      }
    })
    setClipboard({ write })
    await expect(copyToClipboard(Promise.reject(new Error('Only the President and Developers can open the club accounts.')))).rejects.toThrow(
      'Only the President and Developers',
    )
  })

  it('does not write anything when the promised text fails and only writeText exists', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })
    await expect(copyToClipboard(Promise.reject(new Error('no password')))).rejects.toThrow('no password')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('says so when the browser has no clipboard at all', async () => {
    await expect(copyToClipboard('x')).rejects.toThrow(/does not allow copying/)
  })

  it('says so when the clipboard cannot write text', async () => {
    setClipboard({})
    await expect(copyToClipboard('x')).rejects.toThrow(/does not allow copying/)
  })
})
