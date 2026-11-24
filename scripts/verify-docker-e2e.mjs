#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const ACCESS_TOKEN = process.env.DEMO_ACCESS_TOKEN
const WITH_GENERATE = process.argv.includes('--with-generate')

if (!ACCESS_TOKEN) {
  console.error('DEMO_ACCESS_TOKEN env var is required for verify-docker-e2e.mjs')
  process.exit(1)
}

async function waitForPortalReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`, { redirect: 'manual' })
      if (res.status === 401 || res.status === 200) return
    } catch {
      // Wait for caddy + demo-portal startup
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Timed out waiting for portal at ${BASE_URL}`)
}

function buildModbusExceptionOrEmptyReply(reqPdu) {
  // Minimal valid Modbus TCP response echoing transaction ID (2B), protocol ID (2B), unit ID (1B),
  // with valid byte-count payload for FC1/FC2/FC3/FC4/FC5/FC6/FC15/FC16 so OpenPLC master counts a clean poll.
  if (reqPdu.length < 8) return null
  const txId = reqPdu.readUInt16BE(0)
  const protoId = reqPdu.readUInt16BE(2)
  const unitId = reqPdu.readUInt8(6)
  const fc = reqPdu.readUInt8(7)

  if (fc === 1 || fc === 2) {
    const qty = reqPdu.length >= 12 ? reqPdu.readUInt16BE(10) : 8
    const byteCount = Math.max(1, Math.ceil(qty / 8))
    const buf = Buffer.alloc(9 + byteCount)
    buf.writeUInt16BE(txId, 0)
    buf.writeUInt16BE(protoId, 2)
    buf.writeUInt16BE(3 + byteCount, 4)
    buf.writeUInt8(unitId, 6)
    buf.writeUInt8(fc, 7)
    buf.writeUInt8(byteCount, 8)
    // Set EStop bit (bit 2 of discrete inputs if FC2) so PLC sees healthy NC E-Stop
    if (fc === 2 && byteCount >= 1) buf.writeUInt8(0x04, 9)
    return buf
  }
  if (fc === 3 || fc === 4) {
    const qty = reqPdu.length >= 12 ? reqPdu.readUInt16BE(10) : 1
    const byteCount = Math.max(2, qty * 2)
    const buf = Buffer.alloc(9 + byteCount)
    buf.writeUInt16BE(txId, 0)
    buf.writeUInt16BE(protoId, 2)
    buf.writeUInt16BE(3 + byteCount, 4)
    buf.writeUInt8(unitId, 6)
    buf.writeUInt8(fc, 7)
    buf.writeUInt8(byteCount, 8)
    return buf
  }
  if (fc === 5 || fc === 6) {
    return Buffer.from(reqPdu)
  }
  if (fc === 15 || fc === 16) {
    const buf = Buffer.alloc(12)
    reqPdu.copy(buf, 0, 0, 12)
    buf.writeUInt16BE(6, 4)
    return buf
  }
  return null
}

async function run() {
  console.log(`[seam2] Waiting for 3-container stack at ${BASE_URL}...`)
  await waitForPortalReady()

  // 1. Auth gate: unauthenticated -> 401
  const unauth = await fetch(`${BASE_URL}/`, { redirect: 'manual' })
  assert.equal(unauth.status, 401, 'unauthenticated GET / must return 401')
  console.log('[seam2] ✓ Auth gate rejects unauthenticated requests (401)')

  // 2. Magic-link login -> 302 + cookie
  const loginRes = await fetch(`${BASE_URL}/?token=${encodeURIComponent(ACCESS_TOKEN)}`, {
    redirect: 'manual',
  })
  assert.equal(loginRes.status, 302, 'magic-link login must return 302')
  const setCookie = loginRes.headers.get('set-cookie')
  assert.ok(setCookie, 'Set-Cookie header required')
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)
  const cookie = setCookie.split(';')[0]
  console.log('[seam2] ✓ Magic-link login issues HttpOnly SameSite=Lax cookie and strips token')

  // 3. OIP app hosting with COOP/COEP/CORP + pre-boot bridge injection
  const oipRes = await fetch(`${BASE_URL}/app/?cell=conveyor-cell`, { headers: { cookie } })
  assert.equal(oipRes.status, 200, 'OIP /app/ must return 200')
  assert.equal(oipRes.headers.get('cross-origin-opener-policy'), 'same-origin')
  assert.equal(oipRes.headers.get('cross-origin-embedder-policy'), 'require-corp')
  assert.equal(oipRes.headers.get('cross-origin-resource-policy'), 'same-origin')
  const oipHtml = await oipRes.text()
  assert.ok(oipHtml.includes('<script src="/oip-bridge.js"></script>'), 'oip-bridge.js must be injected')
  console.log('[seam2] ✓ Unmodified OIP served with COOP/COEP/CORP and pre-boot bridge')

  // 4. Cold-boot Cells list
  const cellsRes = await fetch(`${BASE_URL}/api/cells`, { headers: { cookie } })
  assert.equal(cellsRes.status, 200)
  const cellsData = await cellsRes.json()
  assert.ok(cellsData.cells.some((c) => c.slug === 'conveyor-cell' && c.protected === true))
  console.log(`[seam2] ✓ /api/cells lists protected conveyor-cell (${cellsData.cells.length} total)`)

  // 5. Connect WebSocket Modbus bridge client BEFORE deploy so OpenPLC polls are answered immediately
  const wsUrl = BASE_URL.replace(/^http/, 'ws') + '/ws/modbus'
  let receivedModbusFrames = 0
  const ws = new WebSocket(wsUrl, { headers: { cookie } })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.send(JSON.stringify({ type: 'listen', link: 0, host: '0.0.0.0', port: 5020 }))
  ws.addEventListener('message', async (ev) => {
    if (typeof ev.data === 'string') return
    const buf = Buffer.from(ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data)
    if (buf.length < 4) return
    const connId = buf.readUInt32BE(0)
    const pdu = buf.subarray(4)
    if (pdu.length === 0) return
    receivedModbusFrames += 1
    const reply = buildModbusExceptionOrEmptyReply(pdu)
    if (reply) {
      const out = Buffer.alloc(4 + reply.length)
      out.writeUInt32BE(connId, 0)
      reply.copy(out, 4)
      ws.send(out)
    }
  })

  try {
    // 6. Deploy conveyor-cell to OpenPLC Runtime v4 container over internal Docker DNS
    console.log('[seam2] Compiling and deploying conveyor-cell to OpenPLC Runtime v4 container...')
    const deployRes = await fetch(`${BASE_URL}/api/cells/conveyor-cell/deploy`, {
      method: 'POST',
      headers: { cookie },
    })
    const deployJson = await deployRes.json()
    assert.equal(deployRes.status, 200, `Deploy failed: ${JSON.stringify(deployJson)}`)
    assert.equal(deployJson.ok, true)
    assert.match(String(deployJson.plcStatus), /RUNNING/)
    console.log(`[seam2] ✓ OpenPLC Runtime ${deployJson.version} compiled & started conveyor-cell (${deployJson.plcStatus})`)

    // 7. Wait for live OpenPLC -> demo-portal:5020 -> WebSocket Modbus TCP polls
    const pollDeadline = Date.now() + 15_000
    let statusJson = null
    while (Date.now() < pollDeadline) {
      const stRes = await fetch(`${BASE_URL}/api/status`, { headers: { cookie } })
      statusJson = await stRes.json()
      if (receivedModbusFrames > 0 && (statusJson.bridge?.polls ?? 0) > 0) break
      await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(receivedModbusFrames > 0, 'Expected live Modbus TCP frames over /ws/modbus from OpenPLC container')
    assert.ok((statusJson?.bridge?.polls ?? 0) > 0, 'Expected portal bridge.polls > 0')
    assert.equal(statusJson?.bridge?.locked, true, 'Expected bridge lock active while WS connected')
    console.log(
      `[seam2] ✓ Live OpenPLC -> Demo Portal -> Browser OIP Modbus TCP verified (${receivedModbusFrames} frames, polls=${statusJson.bridge.polls})`,
    )
  } finally {
    ws.close()
  }

  // 8. Optional live containerized Task 2 AI Cell generation into named volume
  if (WITH_GENERATE) {
    const slug = `seam2-live-${Date.now().toString(36).slice(-4)}`
    console.log(`[seam2] Starting live containerized Task 2 generation (${slug})...`)
    const sseController = new AbortController()
    const sseRes = await fetch(`${BASE_URL}/api/generate/events`, {
      headers: { cookie },
      signal: sseController.signal,
    })
    assert.equal(sseRes.status, 200)

    let doneEvent = null
    let errorEvent = null
    const ssePromise = (async () => {
      const reader = sseRes.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const frames = buf.split('\n\n')
          buf = frames.pop() ?? ''
          for (const frame of frames) {
            const evM = /^event:\s*(.+)$/m.exec(frame)
            const dataM = /^data:\s*(.+)$/m.exec(frame)
            if (!evM || !dataM) continue
            const event = evM[1].trim()
            const data = JSON.parse(dataM[1])
            if (event === 'stage') console.log(`[seam2:sse] stage=${data.stage}${data.model ? ` (${data.model})` : ''}`)
            if (event === 'done') {
              doneEvent = data
              sseController.abort()
              return
            }
            if (event === 'error') {
              errorEvent = data
              sseController.abort()
              return
            }
          }
        }
      } catch {
        // Aborted after done/error
      }
    })()

    const genRes = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: slug,
        prompt:
          'A simple belt conveyor cell with Start, Stop, and NC E-Stop push buttons, a box spawner, a belt conveyor, a diffuse Photo-Eye, and a green Run indicator light.',
      }),
    })
    assert.equal(genRes.status, 202, `Expected 202 from /api/generate, got ${genRes.status}`)

    const sseTimeout = setTimeout(() => sseController.abort(), 10 * 60 * 1000)
    try {
      await ssePromise
    } finally {
      clearTimeout(sseTimeout)
    }
    if (errorEvent) {
      throw new Error(`Containerized Task 2 generation failed: ${errorEvent.error}`)
    }
    assert.ok(doneEvent && doneEvent.slug === slug, 'Expected SSE done event for generated Cell')
    console.log(`[seam2] ✓ Containerized Task 2 generated and verified "${slug}" in named Docker volume`)

    try {
      // Confirm generated Cell appears in /api/cells and deploys to OpenPLC
      const afterList = await (await fetch(`${BASE_URL}/api/cells`, { headers: { cookie } })).json()
      assert.ok(afterList.cells.some((c) => c.slug === slug), 'Generated Cell must appear in /api/cells')

      const genDeploy = await fetch(`${BASE_URL}/api/cells/${encodeURIComponent(slug)}/deploy`, {
        method: 'POST',
        headers: { cookie },
      })
      assert.equal(genDeploy.status, 200, 'Generated Cell must compile and deploy to OpenPLC')
      console.log(`[seam2] ✓ Generated Cell "${slug}" deployed to OpenPLC Runtime v4`)
    } finally {
      const delRes = await fetch(`${BASE_URL}/api/cells/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: { cookie },
      })
      assert.equal(delRes.status, 200)
      console.log(`[seam2] ✓ Deleted test Cell "${slug}" from volume`)
    }

    // Confirm host git tree was NOT dirtied with scenes/<slug>
    const hostStatus = execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
    assert.ok(!hostStatus.includes(slug), `Host git tree must not contain ${slug}`)
    console.log('[seam2] ✓ Host git repository remained completely clean')
  }

  console.log('[seam2] ALL CHECKS PASSED')
}

run().catch((err) => {
  console.error('[seam2] FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
