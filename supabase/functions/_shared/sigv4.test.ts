// The worked examples from the AWS documentation "Signature Calculations for the Authorization
// Header" and "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".
// If these pass, presignUrl() / signRequest() compute exactly what S3, R2 and Supabase Storage verify.
import { describe, expect, it } from 'vitest'
import { EMPTY_SHA256, amzDates, presignUrl, signRequest, uriEncode } from './sigv4.ts'

const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}
const AT = new Date('2013-05-24T00:00:00Z')

describe('sigv4', () => {
  it('matches the AWS presigned-URL example', async () => {
    const url = await presignUrl(AWS_EXAMPLE, {
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      expiresIn: 86400,
      now: AT,
    })
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
  })

  it('matches the AWS header-signed GET-object example (with a Range header)', async () => {
    const headers = await signRequest(AWS_EXAMPLE, {
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      now: AT,
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
    expect(headers['x-amz-date']).toBe('20130524T000000Z')
    expect(headers).not.toHaveProperty('host')
  })

  it('binds a content type into a presigned PUT', async () => {
    const url = await presignUrl(AWS_EXAMPLE, {
      method: 'PUT',
      url: 'https://acc.r2.cloudflarestorage.com/bucket/tasks/a/b.jpg',
      expiresIn: 300,
      now: AT,
      signedHeaders: { 'Content-Type': 'image/jpeg' },
    })
    const q = new URL(url).searchParams
    expect(q.get('X-Amz-SignedHeaders')).toBe('content-type;host')
    expect(q.get('X-Amz-Expires')).toBe('300')
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // A different content type gives a different signature: the browser cannot swap it.
    const other = await presignUrl(AWS_EXAMPLE, {
      method: 'PUT',
      url: 'https://acc.r2.cloudflarestorage.com/bucket/tasks/a/b.jpg',
      expiresIn: 300,
      now: AT,
      signedHeaders: { 'Content-Type': 'text/html' },
    })
    expect(new URL(other).searchParams.get('X-Amz-Signature')).not.toBe(q.get('X-Amz-Signature'))
  })

  it('signs extra query parameters such as a download file name', async () => {
    const url = await presignUrl(AWS_EXAMPLE, {
      method: 'GET',
      url: 'https://acc.r2.cloudflarestorage.com/bucket/k.pdf',
      expiresIn: 60,
      now: AT,
      query: { 'response-content-disposition': `attachment; filename*=UTF-8''${uriEncode('Ölwanne plan.pdf')}` },
    })
    const q = new URL(url).searchParams
    expect(q.get('response-content-disposition')).toBe("attachment; filename*=UTF-8''%C3%96lwanne%20plan.pdf")
    // Signature parameter is last; everything before it is in canonical (sorted) order.
    expect(url.indexOf('response-content-disposition')).toBeGreaterThan(url.indexOf('X-Amz-SignedHeaders'))
  })

  it('keeps a path prefix (the local stack serves S3 under /storage/v1/s3)', async () => {
    const url = await presignUrl(AWS_EXAMPLE, {
      method: 'GET',
      url: 'http://127.0.0.1:54321/storage/v1/s3/attachments-local/tasks/x/y.webp',
      expiresIn: 60,
      now: AT,
    })
    expect(url.startsWith('http://127.0.0.1:54321/storage/v1/s3/attachments-local/tasks/x/y.webp?')).toBe(true)
  })

  it('refuses out-of-range expiry and a URL that already has a query', async () => {
    await expect(presignUrl(AWS_EXAMPLE, { method: 'GET', url: 'https://h/b/k', expiresIn: 0 })).rejects.toThrow()
    await expect(presignUrl(AWS_EXAMPLE, { method: 'GET', url: 'https://h/b/k', expiresIn: 604801 })).rejects.toThrow()
    await expect(presignUrl(AWS_EXAMPLE, { method: 'GET', url: 'https://h/b/k?x=1', expiresIn: 60 })).rejects.toThrow()
  })

  it('encodes like SigV4 (RFC 3986, upper-case hex)', () => {
    expect(uriEncode("a b/c~d*'()!")).toBe('a%20b%2Fc~d%2A%27%28%29%21')
    expect(uriEncode('a/b', true)).toBe('a/b')
    expect(amzDates(AT)).toEqual({ amzDate: '20130524T000000Z', shortDate: '20130524' })
  })
})
