// Put text on the clipboard, where the text may still be on its way from the server.
//
// Safari (Mac and iPhone) only lets a page write to the clipboard while the tap that asked for it is still
// "fresh". Waiting for a network answer first and writing afterwards loses that, and the copy is refused. The
// fix is to give the clipboard a PROMISE for the text at tap time and let the browser wait for it itself.
// Chrome and Firefox accept the same form. Where ClipboardItem is missing the text is awaited first and
// written with writeText, which every browser that lacks ClipboardItem allows without the freshness rule.
//
// The text is never returned, stored or shown: it goes from the caller's promise straight to the clipboard.
export async function copyToClipboard(text: string | Promise<string>): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard) throw new Error('This browser does not allow copying. Open the site over https in an up-to-date browser.')

  if (typeof text !== 'string' && typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    // If the promise rejects, write() rejects too; surface the caller's own reason, not the browser's.
    let reason: unknown = null
    const blob = text.then(
      (value) => new Blob([value], { type: 'text/plain' }),
      (error: unknown) => {
        reason = error
        throw error
      },
    )
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })])
    } catch (error) {
      throw reason ?? error
    }
    return
  }

  if (typeof clipboard.writeText !== 'function') throw new Error('This browser does not allow copying.')
  await clipboard.writeText(await text)
}
