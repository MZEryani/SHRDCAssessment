import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'shrdc_demo_session'

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest()
}

/**
 * Constant-time equality comparison using fixed-length SHA-256 digests so token length never leaks timing.
 */
export function verifySecretToken(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false
  }
  return timingSafeEqual(sha256(candidate), sha256(expected))
}

export function parseCookies(cookieHeader) {
  const cookies = new Map()
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const rawVal = part.slice(eq + 1).trim()
    if (!key) continue
    try {
      cookies.set(key, decodeURIComponent(rawVal))
    } catch {
      // Ignore malformed percent-encoding so invalid cookies safely fail auth with HTTP 401
    }
  }
  return cookies
}

export function isHttpsRequest(req, forceSecureCookies = false) {
  if (forceSecureCookies) return true
  if (req?.socket?.encrypted) return true
  const xfProto = String(req?.headers?.['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return xfProto === 'https'
}

export function createSessionAuth({ accessToken, signingSecret, forceSecureCookies = false }) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Demo Portal requires a non-empty accessToken (DEMO_ACCESS_TOKEN).')
  }
  const hmacKey = createHash('sha256')
    .update(signingSecret || `${accessToken}:${randomBytes(16).toString('hex')}`)
    .digest()

  function signPayload(payload) {
    return createHmac('sha256', hmacKey).update(payload).digest('base64url')
  }

  function issueCookie(req) {
    const nonce = randomBytes(24).toString('base64url')
    const sig = signPayload(nonce)
    const value = `${nonce}.${sig}`
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=86400',
    ]
    if (isHttpsRequest(req, forceSecureCookies)) {
      parts.push('Secure')
    }
    return parts.join('; ')
  }

  function hasValidSession(req) {
    const cookies = parseCookies(req?.headers?.cookie)
    const raw = cookies.get(SESSION_COOKIE_NAME)
    if (!raw) return false
    const dot = raw.indexOf('.')
    if (dot <= 0) return false
    const nonce = raw.slice(0, dot)
    const sig = raw.slice(dot + 1)
    if (!nonce || !sig) return false
    const expectedSig = signPayload(nonce)
    const actualBuf = Buffer.from(sig, 'utf8')
    const expectedBuf = Buffer.from(expectedSig, 'utf8')
    if (actualBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(actualBuf, expectedBuf)
  }

  function verifyToken(candidate) {
    return verifySecretToken(candidate, accessToken)
  }

  return {
    issueCookie,
    hasValidSession,
    verifyToken,
  }
}
