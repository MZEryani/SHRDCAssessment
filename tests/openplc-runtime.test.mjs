import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { deployBundle, OpenPlcClient } from '../scripts/openplc-runtime.mjs'
import {
  buildProgramZip as facadeBuildProgramZip,
  deployBundle as facadeDeployBundle,
  deployProgram,
  OpenPlcClient as FacadeOpenPlcClient,
  resolveStrucppBin as facadeResolveStrucppBin,
} from '../scripts/openplc-deploy.mjs'
import { buildProgramZip, resolveStrucppBin } from '../scripts/plc-bundle.mjs'
import { runCell } from '../scripts/run-cell.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

function derElement(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derSequence(...items) {
  return derElement(0x30, Buffer.concat(items))
}

function derSet(...items) {
  return derElement(0x31, Buffer.concat(items))
}

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
    for (let i = 0; i < chunks.length - 1; i++) {
      chunks[i] |= 0x80
    }
    out.push(...chunks)
  }
  return derElement(0x06, Buffer.from(out))
}

function derUtcTime(date) {
  const pad2 = (n) => String(n).padStart(2, '0')
  const yy = pad2(date.getUTCFullYear() % 100)
  const mm = pad2(date.getUTCMonth() + 1)
  const dd = pad2(date.getUTCDate())
  const hh = pad2(date.getUTCHours())
  const mi = pad2(date.getUTCMinutes())
  const ss = pad2(date.getUTCSeconds())
  return derElement(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'))
}

function derCommonName(cn) {
  return derSequence(
    derSet(derSequence(derOid('2.5.4.3'), derElement(0x13, Buffer.from(cn, 'ascii')))),
  )
}

function createSelfSignedCert() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sha256WithRsaAlgId = derSequence(derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]))
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' })

  const now = Date.now()
  const validity = derSequence(derUtcTime(new Date(now - 60_000)), derUtcTime(new Date(now + 86_400_000)))
  const subject = derCommonName('127.0.0.1')

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

async function startMockRuntime(handler) {
  const { key, cert } = createSelfSignedCert()
  const server = createServer({ key, cert }, (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      Promise.resolve(handler(req, body, res)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `https://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const FAST_POLL = { readyMs: 10, compileMs: 10, statusMs: 10 }

function parseMultipartFile(contentType, body) {
  const match = /boundary=([^\s;]+)/i.exec(contentType ?? '')
  assert.ok(match, `Expected multipart boundary in content-type "${contentType}"`)
  const boundary = match[1]
  const startMarker = Buffer.from(`--${boundary}\r\n`)
  const endMarker = Buffer.from(`\r\n--${boundary}--`)
  const startIdx = body.indexOf(startMarker)
  assert.notEqual(startIdx, -1, 'Missing multipart start boundary')
  const headerEndIdx = body.indexOf(Buffer.from('\r\n\r\n'), startIdx + startMarker.length)
  assert.notEqual(headerEndIdx, -1, 'Missing multipart header terminator')
  const headersText = body.subarray(startIdx + startMarker.length, headerEndIdx).toString('utf8')
  const fileStart = headerEndIdx + 4
  const endIdx = body.indexOf(endMarker, fileStart)
  assert.notEqual(endIdx, -1, 'Missing multipart closing boundary')
  return {
    headersText,
    data: body.subarray(fileStart, endIdx),
  }
}

function createOpenPlcStub({
  version = '4.1.0-loopback',
  userExists = false,
  token = 'jwt-test-token-123',
  loginResponse = { status: 200, body: { access_token: token } },
  uploadResponse = { status: 200, body: { UploadFileOk: 'program.zip' } },
  compileResponses = [{ status: 'COMPILING' }, { status: 'SUCCESS' }],
  startPlcResponse = { status: 200, body: { status: 'STARTING' } },
  statusResponses = [{ status: 'STOPPED' }, { status: 'RUNNING' }],
} = {}) {
  const calls = []
  let uploadedFile = null
  let compileIdx = 0
  let statusIdx = 0

  const protectedPaths = new Set([
    '/api/stop-plc',
    '/api/upload-file',
    '/api/compilation-status',
    '/api/start-plc',
    '/api/status',
  ])

  const handler = (req, body, res) => {
    const entry = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
    }
    calls.push(entry)

    if (protectedPaths.has(req.url) && req.headers.authorization !== `Bearer ${token}`) {
      return sendJson(res, 401, { msg: 'Missing or invalid token' })
    }

    if (req.method === 'GET' && req.url === '/api/version') {
      return sendJson(res, 200, { version })
    }
    if (req.method === 'GET' && req.url === '/api/get-users-info') {
      return userExists ? sendJson(res, 200, { users: ['openplc'] }) : sendJson(res, 404, { msg: 'No users found' })
    }
    if (req.method === 'POST' && req.url === '/api/create-user') {
      entry.json = JSON.parse(body.toString('utf8'))
      return sendJson(res, 201, { status: 'created' })
    }
    if (req.method === 'POST' && req.url === '/api/login') {
      entry.json = JSON.parse(body.toString('utf8'))
      return sendJson(res, loginResponse.status, loginResponse.body)
    }
    if (req.method === 'GET' && req.url === '/api/stop-plc') {
      return sendJson(res, 200, { status: 'STOPPED' })
    }
    if (req.method === 'POST' && req.url === '/api/upload-file') {
      uploadedFile = parseMultipartFile(req.headers['content-type'], body)
      return sendJson(res, uploadResponse.status, uploadResponse.body)
    }
    if (req.method === 'GET' && req.url === '/api/compilation-status') {
      const next = compileResponses[Math.min(compileIdx, compileResponses.length - 1)]
      compileIdx += 1
      return sendJson(res, 200, next)
    }
    if (req.method === 'GET' && req.url === '/api/start-plc') {
      return sendJson(res, startPlcResponse.status, startPlcResponse.body)
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      const next = statusResponses[Math.min(statusIdx, statusResponses.length - 1)]
      statusIdx += 1
      return sendJson(res, 200, next)
    }

    return sendJson(res, 404, { error: `Unhandled ${req.method} ${req.url}` })
  }

  return {
    handler,
    calls,
    getUploadedFile: () => uploadedFile,
  }
}

describe('openplc-runtime', () => {
  it('OpenPlcClient exposes default pollIntervals and retries waitReady past transient non-200 responses', async () => {
    const defaultClient = new OpenPlcClient()
    assert.deepEqual(defaultClient.pollIntervals, { readyMs: 500, compileMs: 1000, statusMs: 250 })

    let versionAttempts = 0
    const mock = await startMockRuntime((req, _body, res) => {
      if (req.method === 'GET' && req.url === '/api/version') {
        versionAttempts += 1
        if (versionAttempts < 3) {
          return sendJson(res, 503, { error: 'booting' })
        }
        return sendJson(res, 200, { version: '4.1.0-test' })
      }
      return sendJson(res, 404, { error: 'not found' })
    })

    try {
      const client = new OpenPlcClient(mock.baseUrl, { pollIntervals: FAST_POLL })
      assert.deepEqual(client.pollIntervals, FAST_POLL)
      const version = await client.waitReady(2000)
      assert.equal(version, '4.1.0-test')
      assert.equal(versionAttempts, 3)
    } finally {
      await mock.close()
    }
  })

  it('deployBundle creates missing user, uploads exact zip bytes with Bearer auth, polls compile & status, and returns stop() handle', async () => {
    const token = 'secret-jwt-abc'
    const stub = createOpenPlcStub({ version: '4.1.2', userExists: false, token })
    const mock = await startMockRuntime(stub.handler)
    const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x2b])
    const md5 = 'deadbeefcafebabe0123456789abcdef'

    try {
      const res = await deployBundle({
        zipBuffer,
        md5,
        runtimeUrl: mock.baseUrl,
        username: 'admin',
        password: 'pw',
        pollIntervals: FAST_POLL,
      })

      assert.equal(res.version, '4.1.2')
      assert.equal(res.md5, md5)
      assert.equal(res.userCreated, true)
      assert.equal(res.compilationStatus, 'SUCCESS')
      assert.equal(res.plcStatus, 'RUNNING')
      assert.equal(typeof res.stop, 'function')
      assert.equal('client' in res, false)

      const uploaded = stub.getUploadedFile()
      assert.ok(uploaded)
      assert.match(uploaded.headersText, /Content-Disposition: form-data; name="file"; filename="program\.zip"/)
      assert.match(uploaded.headersText, /Content-Type: application\/zip/)
      assert.equal(Buffer.compare(uploaded.data, zipBuffer), 0)

      assert.deepEqual(
        stub.calls.map((c) => `${c.method} ${c.url}`),
        [
          'GET /api/version',
          'GET /api/get-users-info',
          'POST /api/create-user',
          'POST /api/login',
          'GET /api/stop-plc',
          'POST /api/upload-file',
          'GET /api/compilation-status',
          'GET /api/compilation-status',
          'GET /api/start-plc',
          'GET /api/status',
          'GET /api/status',
        ],
      )

      const protectedCalls = stub.calls.slice(4)
      for (const call of protectedCalls) {
        assert.equal(call.authorization, `Bearer ${token}`)
      }

      const callsBeforeStop = stub.calls.length
      await res.stop()
      assert.equal(stub.calls.length, callsBeforeStop + 1)
      assert.equal(stub.calls.at(-1).method, 'GET')
      assert.equal(stub.calls.at(-1).url, '/api/stop-plc')
      assert.equal(stub.calls.at(-1).authorization, `Bearer ${token}`)
    } finally {
      await mock.close()
    }
  })

  it('deployBundle skips create-user when user already exists', async () => {
    const stub = createOpenPlcStub({ userExists: true })
    const mock = await startMockRuntime(stub.handler)

    try {
      const res = await deployBundle({
        zipBuffer: Buffer.from('zip-data'),
        md5: '0123456789abcdef0123456789abcdef',
        runtimeUrl: mock.baseUrl,
        pollIntervals: FAST_POLL,
      })

      assert.equal(res.userCreated, false)
      assert.equal(
        stub.calls.some((c) => c.url === '/api/create-user'),
        false,
      )
    } finally {
      await mock.close()
    }
  })

  it('deployBundle with startAfterDeploy=false skips start-plc and returns STOPPED', async () => {
    const stub = createOpenPlcStub({ userExists: true })
    const mock = await startMockRuntime(stub.handler)

    try {
      const res = await deployBundle({
        zipBuffer: Buffer.from('zip-data'),
        md5: '0123456789abcdef0123456789abcdef',
        runtimeUrl: mock.baseUrl,
        startAfterDeploy: false,
        pollIntervals: FAST_POLL,
      })

      assert.equal(res.plcStatus, 'STOPPED')
      assert.equal(res.compilationStatus, 'SUCCESS')
      assert.equal(
        stub.calls.some((c) => c.url === '/api/start-plc' || c.url === '/api/status'),
        false,
      )
    } finally {
      await mock.close()
    }
  })

  it('waitCompilation and deployBundle reject with exit code and log text on FAILED status', async () => {
    const stub = createOpenPlcStub({
      userExists: true,
      compileResponses: [
        { status: 'COMPILING' },
        { status: 'FAILED', exit_code: 2, logs: ['error: undeclared symbol\n', 'build aborted\n'] },
      ],
    })
    const mock = await startMockRuntime(stub.handler)

    try {
      await assert.rejects(
        () =>
          deployBundle({
            zipBuffer: Buffer.from('bad-cpp'),
            md5: '0123456789abcdef0123456789abcdef',
            runtimeUrl: mock.baseUrl,
            pollIntervals: FAST_POLL,
          }),
        (err) => {
          assert.match(err.message, /exit 2/)
          assert.match(err.message, /undeclared symbol/)
          assert.match(err.message, /build aborted/)
          return true
        },
      )
    } finally {
      await mock.close()
    }
  })

  it('deployBundle surfaces upload refusal (UploadFileFail) clearly', async () => {
    const stub = createOpenPlcStub({
      userExists: true,
      uploadResponse: { status: 200, body: { UploadFileFail: 'bad zip' } },
    })
    const mock = await startMockRuntime(stub.handler)

    try {
      await assert.rejects(
        () =>
          deployBundle({
            zipBuffer: Buffer.from('corrupt'),
            md5: '0123456789abcdef0123456789abcdef',
            runtimeUrl: mock.baseUrl,
            pollIntervals: FAST_POLL,
          }),
        /OpenPLC upload refused: bad zip/,
      )
    } finally {
      await mock.close()
    }
  })

  it('deployBundle surfaces HTTP 401 on login and HTTP 500 on start-plc clearly', async () => {
    const loginFailStub = createOpenPlcStub({
      userExists: true,
      loginResponse: { status: 401, body: { msg: 'Bad username or password' } },
    })
    const loginFailMock = await startMockRuntime(loginFailStub.handler)

    try {
      await assert.rejects(
        () =>
          deployBundle({
            zipBuffer: Buffer.from('zip-data'),
            md5: '0123456789abcdef0123456789abcdef',
            runtimeUrl: loginFailMock.baseUrl,
            username: 'alice',
            password: 'wrong',
            pollIntervals: FAST_POLL,
          }),
        (err) => {
          assert.match(err.message, /login failed for "alice"/)
          assert.match(err.message, /HTTP 401/)
          assert.match(err.message, /Bad username or password/)
          return true
        },
      )
    } finally {
      await loginFailMock.close()
    }

    const startFailStub = createOpenPlcStub({
      userExists: true,
      startPlcResponse: { status: 500, body: { error: 'PLC core crashed' } },
    })
    const startFailMock = await startMockRuntime(startFailStub.handler)

    try {
      await assert.rejects(
        () =>
          deployBundle({
            zipBuffer: Buffer.from('zip-data'),
            md5: '0123456789abcdef0123456789abcdef',
            runtimeUrl: startFailMock.baseUrl,
            pollIntervals: FAST_POLL,
          }),
        (err) => {
          assert.match(err.message, /GET \/api\/start-plc failed \(HTTP 500\)/)
          assert.match(err.message, /PLC core crashed/)
          return true
        },
      )
    } finally {
      await startFailMock.close()
    }
  })

  it('deployProgram facade re-exports bundle/runtime symbols and composes buildProgramZip + deployBundle on tracer_bullet.st', async () => {
    assert.equal(FacadeOpenPlcClient, OpenPlcClient)
    assert.equal(facadeDeployBundle, deployBundle)
    assert.equal(facadeBuildProgramZip, buildProgramZip)
    assert.equal(facadeResolveStrucppBin, resolveStrucppBin)

    const stPath = join(REPO_ROOT, 'openplc', 'tracer_bullet.st')
    const expectedMd5 = createHash('md5').update(readFileSync(stPath, 'utf8')).digest('hex')
    const { zipBuffer: expectedZip } = buildProgramZip({ stPath })

    const stub = createOpenPlcStub({ version: '4.1.0-facade', userExists: false })
    const mock = await startMockRuntime(stub.handler)

    try {
      const res = await deployProgram({
        stPath,
        runtimeUrl: mock.baseUrl,
        pollIntervals: FAST_POLL,
      })

      assert.equal(res.version, '4.1.0-facade')
      assert.equal(res.md5, expectedMd5)
      assert.equal(res.userCreated, true)
      assert.equal(res.compilationStatus, 'SUCCESS')
      assert.equal(res.plcStatus, 'RUNNING')
      assert.equal(typeof res.stop, 'function')

      const uploaded = stub.getUploadedFile()
      assert.ok(uploaded)
      assert.equal(Buffer.compare(uploaded.data, expectedZip), 0)

      await res.stop()
      assert.equal(stub.calls.at(-1).url, '/api/stop-plc')
    } finally {
      await mock.close()
    }
  })
})

function extractZipEntryText(zipBuffer, targetName) {
  let offset = 0
  while (offset + 30 <= zipBuffer.length) {
    if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) break
    const method = zipBuffer.readUInt16LE(offset + 8)
    const compSize = zipBuffer.readUInt32LE(offset + 18)
    const nameLen = zipBuffer.readUInt16LE(offset + 26)
    const extraLen = zipBuffer.readUInt16LE(offset + 28)
    const name = zipBuffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8')
    const dataStart = offset + 30 + nameLen + extraLen
    const data = zipBuffer.subarray(dataStart, dataStart + compSize)
    if (name === targetName) {
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8')
    }
    offset = dataStart + compSize
  }
  return null
}

describe('cell:run generic launcher & EC2 env overrides', () => {
  it('deploys conveyor-cell using OPENPLC_URL env override and launches desktop unless deployOnly is set', async () => {
    const stub = createOpenPlcStub({ version: '4.1.0-cell-run', userExists: true })
    const mock = await startMockRuntime(stub.handler)
    const prevUrl = process.env.OPENPLC_URL
    process.env.OPENPLC_URL = mock.baseUrl

    try {
      let desktopLaunchedDir = null
      const res = await runCell({
        slug: 'conveyor-cell',
        repoRoot: REPO_ROOT,
        deployOnly: true,
        pollIntervals: FAST_POLL,
        launchDesktop: ({ cellDir }) => {
          desktopLaunchedDir = cellDir
        },
        log: () => {},
      })

      assert.equal(res.slug, 'conveyor-cell')
      assert.equal(res.deployed.plcStatus, 'RUNNING')
      assert.equal(res.launched, false)
      assert.equal(desktopLaunchedDir, null)
    } finally {
      if (prevUrl === undefined) delete process.env.OPENPLC_URL
      else process.env.OPENPLC_URL = prevUrl
      await mock.close()
    }
  })

  it('deploys a self-contained Cell with OIP_MODBUS_HOST override without mutating the file on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cell-run-fixture-'))
    const cellDir = join(root, 'scenes', 'demo-cell')
    mkdirSync(join(cellDir, 'plc'), { recursive: true })
    cpSync(join(REPO_ROOT, 'scenes', 'conveyor-cell', 'plc', 'program.st'), join(cellDir, 'plc', 'program.st'))
    cpSync(
      join(REPO_ROOT, 'openplc', 'conveyor_cell_modbus_master.json'),
      join(cellDir, 'plc', 'modbus_master.json'),
    )
    cpSync(join(REPO_ROOT, 'openplc', 'io-contract.json'), join(cellDir, 'io-contract.json'))
    cpSync(join(REPO_ROOT, 'scenes', 'conveyor-cell', 'scene.json'), join(cellDir, 'scene.json'))

    const stub = createOpenPlcStub({ version: '4.1.0-ec2', userExists: true })
    const mock = await startMockRuntime(stub.handler)
    const prevHost = process.env.OIP_MODBUS_HOST
    process.env.OIP_MODBUS_HOST = '10.0.1.42'

    try {
      let launchedDir = null
      const res = await runCell({
        slug: 'demo-cell',
        repoRoot: root,
        runtimeUrl: mock.baseUrl,
        pollIntervals: FAST_POLL,
        launchDesktop: ({ cellDir: dir }) => {
          launchedDir = dir
        },
        log: () => {},
      })

      assert.equal(res.deployed.plcStatus, 'RUNNING')
      assert.equal(res.launched, true)
      assert.equal(launchedDir, cellDir)

      const uploaded = stub.getUploadedFile()
      const modbusJson = JSON.parse(extractZipEntryText(uploaded.data, 'conf/modbus_master.json'))
      assert.equal(modbusJson[0].config.host, '10.0.1.42')

      // File on disk must remain untouched
      const diskModbus = JSON.parse(readFileSync(join(cellDir, 'plc', 'modbus_master.json'), 'utf8'))
      assert.equal(diskModbus[0].config.host, 'host.docker.internal')
    } finally {
      if (prevHost === undefined) delete process.env.OIP_MODBUS_HOST
      else process.env.OIP_MODBUS_HOST = prevHost
      await mock.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports openOnly mode by skipping OpenPLC deploy and launching OIP Desktop directly', async () => {
    let deployCalled = false
    let launchedDir = null
    const res = await runCell({
      slug: 'conveyor-cell',
      repoRoot: REPO_ROOT,
      openOnly: true,
      deploy: async () => {
        deployCalled = true
      },
      launchDesktop: ({ cellDir }) => {
        launchedDir = cellDir
      },
      log: () => {},
    })

    assert.equal(deployCalled, false)
    assert.equal(res.deployed, null)
    assert.equal(res.launched, true)
    assert.equal(launchedDir, join(REPO_ROOT, 'scenes', 'conveyor-cell'))

    await assert.rejects(
      () => runCell({ slug: 'conveyor-cell', repoRoot: REPO_ROOT, deployOnly: true, openOnly: true }),
      /Cannot combine --deploy-only and --open-only/,
    )
  })
})
