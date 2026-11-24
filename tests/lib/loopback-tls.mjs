import { generateKeyPairSync, sign } from 'node:crypto'

function derLength(len) {
  if (len < 128) return Buffer.from([len])
  const bytes = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const derElement = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
const derSequence = (...items) => derElement(0x30, Buffer.concat(items))
const derSet = (...items) => derElement(0x31, Buffer.concat(items))

function derOid(oid) {
  const parts = oid.split('.').map(Number)
  const out = [parts[0] * 40 + parts[1]]
  for (const arc of parts.slice(2)) {
    if (arc === 0) {
      out.push(0)
      continue
    }
    const chunks = []
    let n = arc
    while (n > 0) {
      chunks.unshift(n & 0x7f)
      n >>= 7
    }
    for (let i = 0; i < chunks.length - 1; i++) chunks[i] |= 0x80
    out.push(...chunks)
  }
  return derElement(0x06, Buffer.from(out))
}

function derUtcTime(date) {
  const pad2 = (n) => String(n).padStart(2, '0')
  const stamp = [
    pad2(date.getUTCFullYear() % 100),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
  ].join('')
  return derElement(0x17, Buffer.from(`${stamp}Z`, 'ascii'))
}

/**
 * Generate an ephemeral self-signed X.509 RSA certificate for loopback HTTPS test servers.
 */
export function createSelfSignedCert(commonName = '127.0.0.1') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sha256WithRsaAlgId = derSequence(derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]))
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
  const now = Date.now()
  const validity = derSequence(derUtcTime(new Date(now - 60_000)), derUtcTime(new Date(now + 86_400_000)))
  const subject = derSequence(
    derSet(derSequence(derOid('2.5.4.3'), derElement(0x13, Buffer.from(commonName, 'ascii')))),
  )
  const tbsCertificate = derSequence(
    derElement(0x02, Buffer.from([0x01])),
    sha256WithRsaAlgId,
    subject,
    validity,
    subject,
    spkiDer,
  )
  const signature = sign('sha256', tbsCertificate, privateKey)
  const signatureBitString = derElement(0x03, Buffer.concat([Buffer.from([0x00]), signature]))
  const certDer = derSequence(tbsCertificate, sha256WithRsaAlgId, signatureBitString)
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n')

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
  }
}
