import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WS_CLOSE_LOCK_HELD } from '../portal/modbus-bridge.mjs'
import { createDemoPortalServer } from '../portal/server.mjs'
import { createSelfSignedCert } from './lib/loopback-tls.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_TOKEN = 'test-recruiter-secret-token-2026'

function createTempOipDist() {
  const dir = mkdtempSync(join(tmpdir(), 'oip-dist-stub-'))
  mkdirSync(join(dir, 'app'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(
    join(dir, 'app', 'index.html'),
    '<!doctype html><html lang="en"><head><title>OIP</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
    'utf8',
  )
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("oip-stub")\n', 'utf8')
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function extractCookie(setCookieHeader) {
  assert.ok(setCookieHeader, 'expected Set-Cookie header')
  return setCookieHeader.split(';')[0]
}

async function authenticate(portal) {
  const res = await fetch(`${portal.baseUrl}/?token=${TEST_TOKEN}`, { redirect: 'manual' })
  return extractCookie(res.headers.get('set-cookie'))
}

function rawUpgradeStatus(port, extraHeaders = []) {
  return new Promise((resolvePromise, reject) => {
    const sock = new Socket()
    let raw = ''
    sock.connect(port, '127.0.0.1', () => {
      sock.write(
        [
          'GET /ws/modbus HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          ...extraHeaders,
          '',
          '',
        ].join('\r\n'),
      )
    })
    sock.on('data', (chunk) => {
      raw += chunk.toString('utf8')
      const match = /HTTP\/1\.1 (\d{3})/.exec(raw.split('\r\n')[0])
      if (match) {
        sock.destroy()
        resolvePromise(Number(match[1]))
      }
    })
    sock.on('error', reject)
  })
}

function openTestWs(url, cookie) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url, { headers: { cookie } })
    ws.binaryType = 'arraybuffer'
    const textQueue = []
    const binaryQueue = []
    const textWaiters = []
    const binaryWaiters = []
    let closeInfo = null
    const closeWaiters = []

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data)
        if (textWaiters.length > 0) textWaiters.shift()(msg)
        else textQueue.push(msg)
      } else {
        const buf = Buffer.from(ev.data)
        if (binaryWaiters.length > 0) binaryWaiters.shift()(buf)
        else binaryQueue.push(buf)
      }
    })
    ws.addEventListener('close', (ev) => {
      closeInfo = { code: ev.code, reason: ev.reason }
      while (closeWaiters.length > 0) closeWaiters.shift()(closeInfo)
    })
    ws.addEventListener('open', () => {
      resolvePromise({
        ws,
        sendJson: (obj) => ws.send(JSON.stringify(obj)),
        sendBinary: (buf) => ws.send(buf),
        nextJson: () =>
          textQueue.length > 0
            ? Promise.resolve(textQueue.shift())
            : new Promise((r) => textWaiters.push(r)),
        nextBinary: () =>
          binaryQueue.length > 0
            ? Promise.resolve(binaryQueue.shift())
            : new Promise((r) => binaryWaiters.push(r)),
        waitClose: () =>
          closeInfo ? Promise.resolve(closeInfo) : new Promise((r) => closeWaiters.push(r)),
        close: () => ws.close(1000, 'done'),
      })
    })
    ws.addEventListener('error', (err) => reject(err))
  })
}

async function startMockOpenPlc() {
  const { key, cert } = createSelfSignedCert()
  let plcStatus = 'STOPPED'
  let uploadedCount = 0
  let createdUser = null

  const server = createHttpsServer({ key, cert }, (req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.url === '/api/version') return json(200, { version: '4.3.2-mock' })
      if (req.url === '/api/get-users-info') {
        return createdUser ? json(200, { users: [createdUser] }) : json(404, { msg: 'No users found' })
      }
      if (req.url === '/api/create-user') {
        createdUser = JSON.parse(body.toString('utf8'))
        return json(200, { status: 'ok' })
      }
      if (req.url === '/api/login') {
        return json(200, { access_token: 'mock-jwt-token' })
      }
      if (req.url === '/api/stop-plc') {
        plcStatus = 'STOPPED'
        return json(200, { status: 'ok' })
      }
      if (req.url === '/api/upload-file') {
        uploadedCount += 1
        return json(200, { status: 'ok' })
      }
      if (req.url === '/api/compilation-status') {
        return json(200, { status: 'SUCCESS', logs: ['Compiled cleanly'] })
      }
      if (req.url === '/api/start-plc') {
        plcStatus = 'RUNNING'
        return json(200, { status: 'ok' })
      }
      if (req.url === '/api/status') {
        if (req.headers.authorization !== 'Bearer mock-jwt-token') {
          return json(401, { msg: 'Missing Authorization Header' })
        }
        return json(200, { status: plcStatus })
      }
      json(404, { error: 'not found' })
    })
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    baseUrl: `https://127.0.0.1:${port}`,
    getStats: () => ({ plcStatus, uploadedCount, createdUser }),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      }),
  }
}

describe('Demo Portal — Auth Gate', () => {
  it('rejects unauthenticated and malformed-cookie requests across console, API, OIP, and WebSocket routes with HTTP 401', async () => {
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const [rootRes, apiRes, appRes, malformedCookieRes] = await Promise.all([
        fetch(`${portal.baseUrl}/`, { redirect: 'manual' }),
        fetch(`${portal.baseUrl}/api/status`, { redirect: 'manual' }),
        fetch(`${portal.baseUrl}/app/?cell=conveyor-cell`, { redirect: 'manual' }),
        fetch(`${portal.baseUrl}/api/status`, {
          headers: { cookie: 'shrdc_demo_session=%E0%A4%A' },
          redirect: 'manual',
        }),
      ])

      assert.equal(rootRes.status, 401)
      assert.equal(apiRes.status, 401)
      assert.equal(appRes.status, 401)
      assert.equal(malformedCookieRes.status, 401)
      const rootHtml = await rootRes.text()
      assert.match(rootHtml, /<form[^>]+method="POST"[^>]+action="\/auth\/login"/i)

      assert.equal(await rawUpgradeStatus(portal.httpPort), 401)
      assert.equal(
        await rawUpgradeStatus(portal.httpPort, ['Cookie: shrdc_demo_session=%E0%A4%A']),
        401,
      )
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })

  it('authenticates via magic link, sets HttpOnly SameSite=Lax cookie (+ Secure behind HTTPS proxy), strips token on redirect, and supports passphrase POST login', async () => {
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const badMagic = await fetch(`${portal.baseUrl}/?token=wrong-token`, { redirect: 'manual' })
      assert.equal(badMagic.status, 401)
      assert.equal(badMagic.headers.get('set-cookie'), null)

      const magicRes = await fetch(`${portal.baseUrl}/?token=${TEST_TOKEN}&view=act1`, {
        redirect: 'manual',
        headers: { 'x-forwarded-proto': 'https' },
      })
      assert.equal(magicRes.status, 302)
      assert.equal(magicRes.headers.get('location'), '/?view=act1')
      const setCookie = magicRes.headers.get('set-cookie') ?? ''
      assert.match(setCookie, /HttpOnly/i)
      assert.match(setCookie, /SameSite=Lax/i)
      assert.match(setCookie, /Secure/i)

      const cookie = extractCookie(setCookie)
      const authedStatus = await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })
      assert.equal(authedStatus.status, 200)

      const badPost = await fetch(`${portal.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=nope',
        redirect: 'manual',
      })
      assert.equal(badPost.status, 401)

      const goodPost = await fetch(`${portal.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(TEST_TOKEN)}`,
        redirect: 'manual',
      })
      assert.equal(goodPost.status, 302)
      assert.equal(goodPost.headers.get('location'), '/')
      const postCookie = extractCookie(goodPost.headers.get('set-cookie'))
      const authedRoot = await fetch(`${portal.baseUrl}/`, { headers: { cookie: postCookie } })
      assert.equal(authedRoot.status, 200)
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })
})

describe('Demo Portal — OIP Hosting, Headers & Read-Only Cell API', () => {
  it('serves unmodified OIP app with COOP/COEP/CORP, clickjacking headers, and pre-boot bridge injected before module script', async () => {
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)

      const appRes = await fetch(`${portal.baseUrl}/app/?cell=conveyor-cell`, { headers: { cookie } })
      assert.equal(appRes.status, 200)
      assert.equal(appRes.headers.get('cross-origin-opener-policy'), 'same-origin')
      assert.equal(appRes.headers.get('cross-origin-embedder-policy'), 'require-corp')
      assert.equal(appRes.headers.get('cross-origin-resource-policy'), 'same-origin')
      assert.equal(appRes.headers.get('x-frame-options'), 'DENY')
      assert.match(appRes.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
      assert.equal(appRes.headers.get('cache-control'), 'no-store')

      const html = await appRes.text()
      const bridgeIdx = html.indexOf('<script src="/oip-bridge.js"></script>')
      const moduleIdx = html.indexOf('<script type="module"')
      assert.ok(bridgeIdx >= 0, 'expected pre-boot /oip-bridge.js script tag')
      assert.ok(moduleIdx > bridgeIdx, 'pre-boot bridge must load BEFORE OIP module script (and SES lockdown)')

      const assetRes = await fetch(`${portal.baseUrl}/assets/app.js`, { headers: { cookie } })
      assert.equal(assetRes.status, 200)
      assert.equal(assetRes.headers.get('cross-origin-embedder-policy'), 'require-corp')
      assert.equal(assetRes.headers.get('cross-origin-resource-policy'), 'same-origin')
      assert.match(assetRes.headers.get('content-type') ?? '', /javascript/)

      const bridgeRes = await fetch(`${portal.baseUrl}/oip-bridge.js`, { headers: { cookie } })
      assert.equal(bridgeRes.status, 200)
      assert.equal(bridgeRes.headers.get('cross-origin-resource-policy'), 'same-origin')
      const bridgeJs = await bridgeRes.text()
      assert.match(bridgeJs, /window\.oipPlcIo/)
      assert.match(bridgeJs, /window\.oipProject/)
      assert.match(bridgeJs, /\/ws\/modbus/)
      assert.match(bridgeJs, /oip-ec2-remembered-folders/, 'rememberedFolders must persist across OIP reload')
      assert.doesNotMatch(bridgeJs, /\bopenWindow\s*:/, 'must omit optional openWindow so 2nd tabs still render')
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })

  it('serves read-only OIP folder bundles and inspection details for conveyor-cell while blocking traversal and writes', async () => {
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)

      const inspectRes = await fetch(`${portal.baseUrl}/api/cells/conveyor-cell`, { headers: { cookie } })
      assert.equal(inspectRes.status, 200)
      const details = await inspectRes.json()
      assert.equal(details.slug, 'conveyor-cell')
      assert.match(details.stSource, /FUNCTION_BLOCK/)
      assert.equal(details.ioContract.signals.length, 11)

      const folderRes = await fetch(`${portal.baseUrl}/api/cells/conveyor-cell/oip-folder`, {
        headers: { cookie },
      })
      assert.equal(folderRes.status, 200)
      const folder = await folderRes.json()
      assert.equal(folder.docId, 'ec2-cell-conveyor-cell')
      assert.equal(folder.root, 'ec2://scenes/conveyor-cell')
      assert.equal(typeof folder.signature, 'string')
      assert.ok(folder.signature.length > 0)
      const paths = new Set(folder.files.map((f) => f.path))
      assert.ok(paths.has('project.json'))
      assert.ok(paths.has('scene.json'))
      assert.ok(paths.has('plc/program.st'))

      const travRes = await fetch(`${portal.baseUrl}/api/cells/..%2Fopenplc/oip-folder`, {
        headers: { cookie },
      })
      assert.equal(travRes.status, 400)

      const writeRes = await fetch(`${portal.baseUrl}/api/cells/conveyor-cell/oip-folder`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ files: [] }),
      })
      assert.equal(writeRes.status, 405)

      const staticTrav = await fetch(`${portal.baseUrl}/assets/..%2F..%2Fpackage.json`, {
        headers: { cookie },
      })
      assert.ok(staticTrav.status === 400 || staticTrav.status === 403 || staticTrav.status === 404)
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })
})

describe('Demo Portal — Binary WS-to-Modbus TCP Bridge & Strict 30-Minute Lock', () => {
  it('tunnels raw binary Modbus TCP frames between TCP master and browser WebSocket client and increments live poll telemetry', async () => {
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)
      const wsClient = await openTestWs(`ws://127.0.0.1:${portal.httpPort}/ws/modbus`, cookie)

      const ready = await wsClient.nextJson()
      assert.equal(ready.type, 'bridge_ready')
      assert.equal(ready.leaseTimeoutMs, 30 * 60 * 1000)

      wsClient.sendJson({ type: 'listen', link: 0, host: '127.0.0.1', port: 5020 })

      const tcpMaster = new Socket()
      await new Promise((r, rej) => {
        tcpMaster.once('error', rej)
        tcpMaster.connect(portal.modbusPort, '127.0.0.1', r)
      })

      const connOpen = await wsClient.nextJson()
      assert.equal(connOpen.type, 'connection')
      assert.equal(connOpen.open, true)
      const connId = connOpen.id

      const requestAdu = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x02, 0x00, 0x00, 0x00, 0x05])
      tcpMaster.write(requestAdu)

      const incoming = await wsClient.nextBinary()
      assert.equal(incoming.readUInt32BE(0), connId)
      assert.deepEqual(incoming.subarray(4), requestAdu)

      const responseAdu = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x01, 0x02, 0x01, 0x04])
      const replyFrame = Buffer.allocUnsafe(4 + responseAdu.length)
      replyFrame.writeUInt32BE(connId, 0)
      responseAdu.copy(replyFrame, 4)

      const tcpReplyPromise = new Promise((r) => tcpMaster.once('data', r))
      wsClient.sendBinary(replyFrame)
      const tcpReply = await tcpReplyPromise
      assert.deepEqual(tcpReply, responseAdu)

      const statusRes = await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })
      const status = await statusRes.json()
      assert.equal(status.bridge.locked, true)
      assert.ok(status.bridge.polls >= 1)
      assert.equal(status.bridge.activeMasters, 1)

      tcpMaster.destroy()
      wsClient.close()
      await wsClient.waitClose()
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })

  it('strictly rejects a second concurrent session, holds the lock for 29m59s, and evicts after 30 minutes or clean disconnect', async () => {
    let fakeNow = 1_700_000_000_000
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
      leaseTimeoutMs: 30 * 60 * 1000,
      now: () => fakeNow,
    })

    try {
      const cookie = await authenticate(portal)

      const client1 = await openTestWs(`ws://127.0.0.1:${portal.httpPort}/ws/modbus`, cookie)
      const ready1 = await client1.nextJson()
      assert.equal(ready1.type, 'bridge_ready')

      const client2 = await openTestWs(`ws://127.0.0.1:${portal.httpPort}/ws/modbus`, cookie)
      const rejected = await client2.nextJson()
      assert.equal(rejected.type, 'lock_rejected')
      const closed2 = await client2.waitClose()
      assert.equal(closed2.code, WS_CLOSE_LOCK_HELD)

      // At 29 minutes 59 seconds: lock must still hold (Cell observation protection)
      fakeNow += 29 * 60 * 1000 + 59 * 1000
      portal.checkBridgeExpiry()
      const clientStillBlocked = await openTestWs(`ws://127.0.0.1:${portal.httpPort}/ws/modbus`, cookie)
      const rejectedAt29m59s = await clientStillBlocked.nextJson()
      assert.equal(rejectedAt29m59s.type, 'lock_rejected')
      await clientStillBlocked.waitClose()

      // Past 30 minutes: stale session 1 is evicted and session 3 attaches cleanly
      fakeNow += 2000
      portal.checkBridgeExpiry()
      await client1.waitClose()

      const client3 = await openTestWs(`ws://127.0.0.1:${portal.httpPort}/ws/modbus`, cookie)
      const ready3 = await client3.nextJson()
      assert.equal(ready3.type, 'bridge_ready')

      // Clean disconnect releases lock immediately
      client3.close()
      await client3.waitClose()

      const client4 = await openTestWs(`ws://127.0.0.1:${portal.httpPort}/ws/modbus`, cookie)
      const ready4 = await client4.nextJson()
      assert.equal(ready4.type, 'bridge_ready')
      client4.close()
      await client4.waitClose()
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })
})

describe('Demo Portal — Act 1 Guided Journey UI & Task 1 OpenPLC Deploy', () => {
  it('probes live OpenPLC Runtime status before and after compiling/deploying conveyor-cell with OIP_MODBUS_HOST', async () => {
    const oipStub = createTempOipDist()
    const mockPlc = await startMockOpenPlc()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      openplc: {
        url: mockPlc.baseUrl,
        oipModbusHost: 'demo-portal',
        username: 'openplc',
        password: 'test-runtime-password',
        pollIntervals: { readyMs: 10, compileMs: 10, statusMs: 10 },
      },
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)

      // Live telemetry queries OpenPLC Runtime directly even before first deploy
      const preStatusRes = await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })
      const preStatus = await preStatusRes.json()
      assert.equal(preStatus.openplc.version, '4.3.2-mock')
      assert.equal(preStatus.openplc.plcStatus, 'STOPPED')

      const deployRes = await fetch(`${portal.baseUrl}/api/cells/conveyor-cell/deploy`, {
        method: 'POST',
        headers: { cookie },
      })
      assert.equal(deployRes.status, 200)
      const deployed = await deployRes.json()
      assert.equal(deployed.ok, true)
      assert.equal(deployed.slug, 'conveyor-cell')
      assert.equal(deployed.version, '4.3.2-mock')
      assert.equal(deployed.compilationStatus, 'SUCCESS')
      assert.equal(deployed.plcStatus, 'RUNNING')
      assert.equal(deployed.launchUrl, '/app/?cell=conveyor-cell')

      const mockStats = mockPlc.getStats()
      assert.equal(mockStats.uploadedCount, 1)
      assert.equal(mockStats.createdUser?.password, 'test-runtime-password')

      const postStatusRes = await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })
      const postStatus = await postStatusRes.json()
      assert.equal(postStatus.openplc.activeCell, 'conveyor-cell')
      assert.equal(postStatus.openplc.plcStatus, 'RUNNING')
      assert.equal(postStatus.openplc.version, '4.3.2-mock')

      const missingRes = await fetch(`${portal.baseUrl}/api/cells/no-such-cell/deploy`, {
        method: 'POST',
        headers: { cookie },
      })
      assert.equal(missingRes.status, 404)

      const badSlugRes = await fetch(`${portal.baseUrl}/api/cells/..%2Fevil/deploy`, {
        method: 'POST',
        headers: { cookie },
      })
      assert.equal(badSlugRes.status, 400)
    } finally {
      await portal.close()
      await mockPlc.close()
      oipStub.cleanup()
    }
  })

  it('renders the Guided Recruiter Journey UI with Act 1 controls, sticky runtime inspector, native modal dialog, and dark-mode support', async () => {
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)
      const res = await fetch(`${portal.baseUrl}/`, { headers: { cookie } })
      assert.equal(res.status, 200)
      const html = await res.text()

      assert.match(html, /<meta name="color-scheme" content="light dark"/i)
      assert.match(html, /<main\b/i)
      assert.match(html, /<aside\b/i)
      assert.match(html, /Act 1/i)
      assert.match(html, /conveyor-cell/)
      assert.match(html, /Inspection Dwell/)
      assert.match(html, /Photo-Eye/)
      assert.match(html, /<dialog\b[^>]*id="inspector-dialog"/i)
      assert.doesNotMatch(html, /\bonclick=/i, 'must avoid inline onclick handlers for strict CSP')
      assert.doesNotMatch(html, /Ticket #\d+/i, 'must not leak internal ticket numbers in recruiter UI')
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })
})

describe('Demo Portal — Persistent Cell Lifecycle & Orchestration Proof API', () => {
  it('starts clean on cold boot with only conveyor-cell, serves committed proof, and guards deletion against protected Cell and traversal', async () => {
    const oipStub = createTempOipDist()
    const cellsDir = mkdtempSync(join(tmpdir(), 'portal-cells-'))
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      generatedCellsDir: cellsDir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)

      // Cold start: only protected conveyor-cell exists
      const listRes = await fetch(`${portal.baseUrl}/api/cells`, { headers: { cookie } })
      assert.equal(listRes.status, 200)
      const list = await listRes.json()
      assert.equal(list.cells.length, 1)
      assert.equal(list.cells[0].slug, 'conveyor-cell')
      assert.equal(list.cells[0].protected, true)

      // Committed orchestration proof endpoint returns parsed JSON + markdown
      const proofRes = await fetch(`${portal.baseUrl}/api/proof`, { headers: { cookie } })
      assert.equal(proofRes.status, 200)
      const proof = await proofRes.json()
      assert.ok(proof.json?.runId, 'expected committed proof runId')
      assert.match(proof.markdown, /OpenCode Parallel/)

      // Protected conveyor-cell cannot be deleted (403); traversal rejected (400); missing returns 404
      const delProtected = await fetch(`${portal.baseUrl}/api/cells/conveyor-cell`, {
        method: 'DELETE',
        headers: { cookie },
      })
      assert.equal(delProtected.status, 403)

      const delTraversal = await fetch(`${portal.baseUrl}/api/cells/..%2Fscenes`, {
        method: 'DELETE',
        headers: { cookie },
      })
      assert.equal(delTraversal.status, 400)

      const delMissing = await fetch(`${portal.baseUrl}/api/cells/does-not-exist`, {
        method: 'DELETE',
        headers: { cookie },
      })
      assert.equal(delMissing.status, 404)
    } finally {
      await portal.close()
      rmSync(cellsDir, { recursive: true, force: true })
      oipStub.cleanup()
    }
  })

  it('streams 4-stage SSE progress, enforces single-flight 409 and daily cap 429, and persists/inspects/deploys/deletes generated Cells', async () => {
    let fakeNow = Date.parse('2026-11-24T10:00:00.000Z')
    const oipStub = createTempOipDist()
    const cellsDir = mkdtempSync(join(tmpdir(), 'portal-gen-cells-'))
    const mockPlc = await startMockOpenPlc()

    let releaseFirstRun
    let callCount = 0

    const fakeGenerateCell = async ({ prompt, name, cellsDir: outRoot, onEvent, log }) => {
      callCount += 1
      const slug = name || `gen-cell-${callCount}`
      onEvent({ stage: 'preflight', slug })
      log(`[test] preflight ok for ${slug}`)
      onEvent({ stage: 'stage1', slug, model: 'google/gemini-4-neon' })

      if (callCount === 1) {
        await new Promise((r) => {
          releaseFirstRun = r
        })
      }

      onEvent({ stage: 'stage2', slug, model: 'google/gemini-3.8-flash' })
      onEvent({ stage: 'stage3', slug })
      onEvent({ stage: 'stage4', slug })

      const targetDir = join(outRoot, slug)
      mkdirSync(join(targetDir, 'plc'), { recursive: true })
      writeFileSync(
        join(targetDir, 'project.json'),
        JSON.stringify({ version: 1, name: slug, scene: 'scene.json', program: ['plc/program.st'], tests: [] }),
        'utf8',
      )
      writeFileSync(
        join(targetDir, 'scene.json'),
        JSON.stringify({ version: 4, parts: [], plcs: [{ name: 'PLC1', runsOn: 'plc', protocol: 'serve', connect: true }] }),
        'utf8',
      )
      writeFileSync(
        join(targetDir, 'plc', 'program.st'),
        readFileSync(join(REPO_ROOT, 'scenes', 'conveyor-cell', 'plc', 'program.st'), 'utf8'),
        'utf8',
      )
      writeFileSync(
        join(targetDir, 'plc', 'modbus_master.json'),
        readFileSync(join(REPO_ROOT, 'openplc', 'conveyor_cell_modbus_master.json'), 'utf8'),
        'utf8',
      )
      writeFileSync(
        join(targetDir, 'io-contract.json'),
        readFileSync(join(REPO_ROOT, 'openplc', 'io-contract.json'), 'utf8'),
        'utf8',
      )
      writeFileSync(join(targetDir, 'process-spec.md'), `# ${slug}\n\n${prompt}\n`, 'utf8')
      const report = {
        ok: true,
        runId: `run-${callCount}`,
        slug,
        capturedAt: new Date(fakeNow).toISOString(),
        totals: { durationMs: 4200, costUsd: 0.12 },
        verification: { ok: true, gates: { contract: { passed: true }, plcTest: { passed: true }, oipValidate: { passed: true } } },
      }
      writeFileSync(join(targetDir, 'generation-report.json'), JSON.stringify(report), 'utf8')
      onEvent({ stage: 'done', slug, mode: 'generate', outputDir: targetDir })
      return report
    }

    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      generatedCellsDir: cellsDir,
      accessToken: TEST_TOKEN,
      dailyGenerationCap: 2,
      generateCellFn: fakeGenerateCell,
      openplc: {
        url: mockPlc.baseUrl,
        oipModbusHost: 'demo-portal',
        username: 'openplc',
        password: 'test-runtime-password',
        pollIntervals: { readyMs: 10, compileMs: 10, statusMs: 10 },
      },
      now: () => fakeNow,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)

      // Open SSE stream before starting generation
      const sseController = new AbortController()
      const sseRes = await fetch(`${portal.baseUrl}/api/generate/events`, {
        headers: { cookie },
        signal: sseController.signal,
      })
      assert.equal(sseRes.status, 200)
      assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/)

      const receivedEvents = []
      const sseReader = sseRes.body.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''
      const readEvents = (async () => {
        try {
          while (true) {
            const { done, value } = await sseReader.read()
            if (done) break
            sseBuffer += decoder.decode(value, { stream: true })
            const frames = sseBuffer.split('\n\n')
            sseBuffer = frames.pop() ?? ''
            for (const frame of frames) {
              const evMatch = /^event:\s*(.+)$/m.exec(frame)
              const dataMatch = /^data:\s*(.+)$/m.exec(frame)
              if (evMatch && dataMatch) {
                receivedEvents.push({ event: evMatch[1].trim(), data: JSON.parse(dataMatch[1]) })
              }
            }
          }
        } catch {
          // Aborted on cleanup
        }
      })()

      // Start Run 1
      const start1 = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'A roller conveyor sorting red boxes', name: 'sorter-live' }),
      })
      assert.equal(start1.status, 202)
      const started1 = await start1.json()
      assert.equal(started1.ok, true)
      assert.equal(started1.slug, 'sorter-live')

      // Wait until stage1 pauses on releaseFirstRun
      while (!releaseFirstRun) await new Promise((r) => setTimeout(r, 5))

      // Overlapping request rejected with HTTP 409 (single-flight)
      const overlap = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Another cell while busy', name: 'busy-cell' }),
      })
      assert.equal(overlap.status, 409)

      // Release Run 1 and wait for SSE 'done'
      releaseFirstRun()
      const deadline = Date.now() + 3000
      while (!receivedEvents.some((e) => e.event === 'done') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      sseController.abort()
      await readEvents

      const stages = receivedEvents.filter((e) => e.event === 'stage').map((e) => e.data.stage)
      assert.ok(stages.includes('stage1'))
      assert.ok(stages.includes('stage2'))
      assert.ok(stages.includes('stage3'))
      assert.ok(stages.includes('stage4'))
      assert.ok(receivedEvents.some((e) => e.event === 'done' && e.data.slug === 'sorter-live'))

      // Quota reflects 1/2 used
      const statusRes = await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })
      const status = await statusRes.json()
      assert.equal(status.generation.quota.used, 1)
      assert.equal(status.generation.quota.cap, 2)

      // Generated Cell appears in list, inspects cleanly, serves OIP folder, deploys to OpenPLC, and deletes safely
      const listRes = await fetch(`${portal.baseUrl}/api/cells`, { headers: { cookie } })
      const list = await listRes.json()
      assert.deepEqual(
        list.cells.map((c) => c.slug),
        ['conveyor-cell', 'sorter-live'],
      )

      const detailRes = await fetch(`${portal.baseUrl}/api/cells/sorter-live`, { headers: { cookie } })
      const details = await detailRes.json()
      assert.equal(details.generationReport?.runId, 'run-1')

      const folderRes = await fetch(`${portal.baseUrl}/api/cells/sorter-live/oip-folder`, { headers: { cookie } })
      assert.equal(folderRes.status, 200)

      const deployRes = await fetch(`${portal.baseUrl}/api/cells/sorter-live/deploy`, {
        method: 'POST',
        headers: { cookie },
      })
      assert.equal(deployRes.status, 200)
      assert.equal((await deployRes.json()).launchUrl, '/app/?cell=sorter-live')

      // Protected conveyor-cell overwrite rejected with 403, invalid slug with 400, existing slug with 409 (without burning quota)
      const overwriteProtected = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Try overwriting reference cell', name: 'conveyor-cell' }),
      })
      assert.equal(overwriteProtected.status, 403)

      const badSlug = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Bad slug', name: '../escape' }),
      })
      assert.equal(badSlug.status, 400)

      const dupSlug = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Duplicate existing slug', name: 'sorter-live' }),
      })
      assert.equal(dupSlug.status, 409)
      const quotaAfterGuard = (await (await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })).json()).generation.quota
      assert.equal(quotaAfterGuard.used, 1)

      const delRes = await fetch(`${portal.baseUrl}/api/cells/sorter-live`, {
        method: 'DELETE',
        headers: { cookie },
      })
      assert.equal(delRes.status, 200)
      const afterDel = await (await fetch(`${portal.baseUrl}/api/cells`, { headers: { cookie } })).json()
      assert.deepEqual(
        afterDel.cells.map((c) => c.slug),
        ['conveyor-cell'],
      )

      // Run 2 hits daily cap (2/2), then Run 3 is rejected with HTTP 429
      const start2 = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Second cell today', name: 'cell-two' }),
      })
      assert.equal(start2.status, 202)
      while ((await (await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })).json()).generation.running) {
        await new Promise((r) => setTimeout(r, 10))
      }

      const capped = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Third cell over cap', name: 'cell-three' }),
      })
      assert.equal(capped.status, 429)

      // Next UTC day resets daily cap
      fakeNow += 24 * 60 * 60 * 1000
      const nextDay = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Next day cell', name: 'cell-next-day' }),
      })
      assert.equal(nextDay.status, 202)
      while ((await (await fetch(`${portal.baseUrl}/api/status`, { headers: { cookie } })).json()).generation.running) {
        await new Promise((r) => setTimeout(r, 10))
      }
    } finally {
      await portal.close()
      await mockPlc.close()
      rmSync(cellsDir, { recursive: true, force: true })
      oipStub.cleanup()
    }
  })

  it('renders Act 2 live AI generator form, SSE pipeline progress, proof trigger, Act 3 Cell library, and AI quota telemetry', async () => {
    const oipStub = createTempOipDist()
    const portal = await createDemoPortalServer({
      repoRoot: REPO_ROOT,
      oipDistDir: oipStub.dir,
      accessToken: TEST_TOKEN,
      httpPort: 0,
      modbusListenPort: 0,
    })

    try {
      const cookie = await authenticate(portal)
      const res = await fetch(`${portal.baseUrl}/`, { headers: { cookie } })
      assert.equal(res.status, 200)
      const html = await res.text()

      assert.match(html, /id="generate-form"/)
      assert.match(html, /<label for="prompt-input"/)
      assert.match(html, /<textarea[^>]*id="prompt-input"/)
      assert.match(html, /<label for="cell-name-input"/)
      assert.match(html, /data-preset-prompt=/)
      assert.match(html, /<progress[^>]*id="gen-progress"/)
      assert.match(html, /new EventSource\('\/api\/generate\/events'\)/)
      assert.match(html, /id="btn-view-proof"/)
      assert.match(html, /id="generated-cells-list"/)
      assert.match(html, /id="rt-quota"/)
      assert.doesNotMatch(html, /\bonclick=/i)

      // When PORTAL_CELLS_DIR (generatedCellsDir) is unset, POST /api/generate fails cleanly with 503 instead of mutating scenes/
      const unconfiguredRes = await fetch(`${portal.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'A conveyor cell' }),
      })
      assert.equal(unconfiguredRes.status, 503)
    } finally {
      await portal.close()
      oipStub.cleanup()
    }
  })
})
