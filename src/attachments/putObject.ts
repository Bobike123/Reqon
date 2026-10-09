// One signed PUT straight to the bucket, with upload progress. fetch() cannot report upload progress in
// any browser this app supports, so this is XMLHttpRequest. The signature covers the Content-Type, so the
// headers the Edge Function returned are sent exactly as given (and nothing else that is signed).

export class PutError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'PutError'
    this.status = status
  }
}

export function putObject(
  request: { url: string; headers: Record<string, string> },
  body: Blob,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', request.url)
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) options.onProgress?.(e.loaded / e.total)
    }
    const onAbort = () => xhr.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => options.signal?.removeEventListener('abort', onAbort)
    xhr.onload = () => {
      done()
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(1)
        resolve()
      } else if (xhr.status === 403) {
        // An expired or mismatched signature. The caller asks for a new URL.
        reject(new PutError('The upload link expired. Try again.', 403))
      } else {
        reject(new PutError(`File storage refused the upload (error ${xhr.status}). Try again.`, xhr.status))
      }
    }
    xhr.onerror = () => {
      done()
      reject(new PutError('The upload was interrupted. Check your connection and try again.', 0))
    }
    xhr.onabort = () => {
      done()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    xhr.send(body)
  })
}
