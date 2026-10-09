import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAttachmentUrls } from '../data/useAttachments.ts'
import { urlIsFresh } from './rules.ts'

type Link = { url: string; fetchedAt: number; expiresIn: number }

// The one active player (ATT-11, ARCHITECTURE.md §6). preload="metadata" + range requests: opening a
// 30 MB video downloads only what is watched. The signed link lives an hour; when it expires mid-way
// (a long pause), the element errors — a fresh link is fetched and playback resumes where it was.
export function VideoPlayer({ attachmentId, poster, name }: { attachmentId: string; poster: string | null; name: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [link, setLink] = useState<Link | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const resume = useRef<{ time: number; play: boolean } | null>(null)
  const playing = useRef(false)
  const refreshing = useRef(false)
  const refreshes = useRef(0)

  const load = useCallback(async () => {
    const answer = await fetchAttachmentUrls([attachmentId], 'original')
    const url = answer.urls[attachmentId]
    if (!url) throw new Error('This video is no longer available.')
    return { url, fetchedAt: answer.fetchedAt, expiresIn: answer.expiresIn }
  }, [attachmentId])

  useEffect(() => {
    let live = true
    load().then(
      (l) => live && setLink(l),
      (e: unknown) => live && setFailure(e instanceof Error ? e.message : 'The video could not be opened.'),
    )
    return () => {
      live = false
    }
  }, [load])

  const refresh = useCallback(() => {
    const el = video.current
    if (!el || refreshing.current) return
    refreshing.current = true
    refreshes.current += 1
    resume.current = { time: el.currentTime, play: playing.current }
    load().then(
      (l) => {
        refreshing.current = false
        setLink(l)
      },
      (e: unknown) => {
        refreshing.current = false
        setFailure(e instanceof Error ? e.message : 'The video could not be reloaded.')
      },
    )
  }, [load])

  const onError = () => {
    // An expired link, or the first error of this element: one fresh link. A fresh link that still fails
    // is a file this browser cannot play.
    if (link && (!urlIsFresh(link.fetchedAt, link.expiresIn, Date.now()) || refreshes.current === 0)) {
      refresh()
      return
    }
    setFailure('This video cannot be played in this browser. Download it to watch it.')
  }

  if (failure) {
    return (
      <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800" data-testid="video-failure">
        {failure}
      </p>
    )
  }
  return (
    <video
      ref={video}
      key={link?.url ?? 'pending'}
      src={link?.url}
      poster={poster ?? undefined}
      controls
      playsInline
      preload="metadata"
      aria-label={name}
      className="max-h-[70dvh] w-full rounded bg-black"
      data-testid="video-player"
      onPlay={(e) => {
        playing.current = true
        // Starting again after a long pause on an old link: swap the link before the request fails.
        if (link && !urlIsFresh(link.fetchedAt, link.expiresIn, Date.now())) {
          e.currentTarget.pause()
          playing.current = true
          refresh()
        }
      }}
      onPause={() => {
        if (!refreshing.current) playing.current = false
      }}
      onLoadedMetadata={(e) => {
        const at = resume.current
        resume.current = null
        if (!at) return
        e.currentTarget.currentTime = at.time
        if (at.play) void e.currentTarget.play().catch(() => {})
      }}
      onError={onError}
    />
  )
}
