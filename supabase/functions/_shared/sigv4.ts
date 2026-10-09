// AWS Signature Version 4 for S3-compatible object storage (Cloudflare R2 in production, the
// local Supabase stack's S3 endpoint in development and CI). Dependency-free: WebCrypto only,
// so the same file runs in the Edge Runtime (Deno) and under Vitest (Node).
//
// Two operations are needed and nothing more:
//   presignUrl()   a URL the BROWSER uses once (PUT an upload, GET a download) — query-string
//                  signature, payload UNSIGNED-PAYLOAD, optionally binding Content-Type.
//   signRequest()  headers for a request the FUNCTION makes itself (HEAD, DELETE).
// Verified against the worked examples in the AWS S3 SigV4 documentation (sigv4.test.ts).

const ALGORITHM = 'AWS4-HMAC-SHA256'
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export type Credentials = { accessKeyId: string; secretAccessKey: string; region: string; service?: string }

const encoder = new TextEncoder()

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, encoder.encode(text))
}

// RFC 3986 unreserved characters stay; everything else is %XX (upper case), as SigV4 requires.
export function uriEncode(value: string, keepSlash = false): string {
  let out = ''
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) {
      out += ch
    } else {
      for (const byte of encoder.encode(ch)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return out
}

// 20130524T000000Z / 20130524
export function amzDates(now: Date): { amzDate: string; shortDate: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate, shortDate: amzDate.slice(0, 8) }
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&')
}

function canonicalHeaders(headers: Record<string, string>): { block: string; signed: string } {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  const names = Object.keys(lower).sort()
  return { block: names.map((n) => `${n}:${lower[n]}\n`).join(''), signed: names.join(';') }
}

async function signature(creds: Credentials, shortDate: string, stringToSign: string): Promise<string> {
  const service = creds.service ?? 's3'
  const kDate = await hmac(encoder.encode('AWS4' + creds.secretAccessKey), shortDate)
  const kRegion = await hmac(kDate, creds.region)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')
  return toHex(await hmac(kSigning, stringToSign))
}

function scopeOf(creds: Credentials, shortDate: string): string {
  return `${shortDate}/${creds.region}/${creds.service ?? 's3'}/aws4_request`
}

// The path of a URL as SigV4 wants it: every segment encoded once.
function canonicalPath(url: URL): string {
  return url.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/')
}

export type PresignInput = {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  url: string // full object URL without a query string
  expiresIn: number // seconds, 1 .. 604800
  now?: Date
  // Headers the client MUST send with exactly these values (e.g. content-type for a PUT).
  signedHeaders?: Record<string, string>
  // Extra query parameters that become part of the signature (e.g. response-content-disposition).
  query?: Record<string, string>
}

export async function presignUrl(creds: Credentials, input: PresignInput): Promise<string> {
  if (!Number.isInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > 604800) {
    throw new Error('expiresIn must be 1..604800 seconds')
  }
  const url = new URL(input.url)
  if (url.search) throw new Error('presignUrl takes a URL without a query string')
  const { amzDate, shortDate } = amzDates(input.now ?? new Date())
  const headers = canonicalHeaders({ host: url.host, ...(input.signedHeaders ?? {}) })
  const params: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${creds.accessKeyId}/${scopeOf(creds, shortDate)}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresIn),
    'X-Amz-SignedHeaders': headers.signed,
  }
  const query = canonicalQuery(params)
  const canonicalRequest = [input.method, canonicalPath(url), query, headers.block, headers.signed, UNSIGNED_PAYLOAD].join('\n')
  const stringToSign = [ALGORITHM, amzDate, scopeOf(creds, shortDate), await sha256Hex(canonicalRequest)].join('\n')
  const sig = await signature(creds, shortDate, stringToSign)
  return `${url.origin}${canonicalPath(url)}?${query}&X-Amz-Signature=${sig}`
}

export type SignInput = {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  url: string
  now?: Date
  headers?: Record<string, string>
  payloadHash?: string // defaults to the hash of an empty body
}

// Returns the headers to send (including Authorization) for a request the server makes itself.
export async function signRequest(creds: Credentials, input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url)
  const { amzDate, shortDate } = amzDates(input.now ?? new Date())
  const payloadHash = input.payloadHash ?? EMPTY_SHA256
  const toSign: Record<string, string> = {
    ...(input.headers ?? {}),
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  const headers = canonicalHeaders(toSign)
  const query = canonicalQuery(Object.fromEntries(url.searchParams.entries()))
  const canonicalRequest = [input.method, canonicalPath(url), query, headers.block, headers.signed, payloadHash].join('\n')
  const stringToSign = [ALGORITHM, amzDate, scopeOf(creds, shortDate), await sha256Hex(canonicalRequest)].join('\n')
  const sig = await signature(creds, shortDate, stringToSign)
  const out: Record<string, string> = { ...toSign }
  delete out.host // fetch sets Host itself
  out.authorization = `${ALGORITHM} Credential=${creds.accessKeyId}/${scopeOf(creds, shortDate)}, SignedHeaders=${headers.signed}, Signature=${sig}`
  return out
}
