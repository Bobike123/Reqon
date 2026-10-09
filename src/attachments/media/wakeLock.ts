// Keeps a phone's screen on while a video is being compressed (ATT-12): a sleeping phone suspends the
// page and the encoder with it. Best effort — unsupported or refused (low battery) simply means no lock.
// The browser drops the lock whenever the page is hidden, so it is taken again when the page returns.

type Sentinel = { release: () => Promise<void> }
type WakeLockApi = { request: (type: 'screen') => Promise<Sentinel> }

export function holdScreenAwake(): () => void {
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock
  if (!api) return () => {}
  let sentinel: Sentinel | null = null
  let released = false
  const acquire = () => {
    if (released || document.visibilityState !== 'visible') return
    api.request('screen').then(
      (s) => {
        if (released) void s.release().catch(() => {})
        else sentinel = s
      },
      () => {},
    )
  }
  const onVisible = () => acquire()
  document.addEventListener('visibilitychange', onVisible)
  acquire()
  return () => {
    released = true
    document.removeEventListener('visibilitychange', onVisible)
    void sentinel?.release().catch(() => {})
    sentinel = null
  }
}
