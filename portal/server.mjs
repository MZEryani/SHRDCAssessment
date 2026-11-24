import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionAuth } from './auth.mjs'
import { createCellStore } from './cell-store.mjs'
import { renderConsolePage, renderLoginPage } from './console-ui.mjs'
import {
  createGenerationManager,
  DEFAULT_DAILY_GENERATION_CAP,
} from './generation-manager.mjs'
import { createModbusBridge, DEFAULT_LEASE_TIMEOUT_MS } from './modbus-bridge.mjs'
import { acceptWebSocket } from './ws-server.mjs'
import { deployProgram } from '../scripts/openplc-deploy.mjs'
import { OpenPlcClient } from '../scripts/openplc-runtime.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORTAL_DIR = dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 1024 * 1024

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

const FRAME_PROTECTION_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
}

const OIP_COI_HEADERS = {
  ...FRAME_PROTECTION_HEADERS,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...FRAME_PROTECTION_HEADERS,
    ...extraHeaders,
  })
  res.end(JSON.stringify(payload))
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...FRAME_PROTECTION_HEADERS,
    ...extraHeaders,
  })
  res.end(html)
}

function rejectUpgrade(socket, status, reason) {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}

function injectPreBootBridge(html) {
  const tag = '<script src="/oip-bridge.js"></script>'
  if (html.includes(tag)) return html
  const moduleMatch = /<script\b[^>]*type=["']module["'][^>]*>/i.exec(html)
  if (moduleMatch && typeof moduleMatch.index === 'number') {
    return `${html.slice(0, moduleMatch.index)}${tag}\n    ${html.slice(moduleMatch.index)}`
  }
  const headClose = html.indexOf('</head>')
  if (headClose >= 0) {
    return `${html.slice(0, headClose)}    ${tag}\n  ${html.slice(headClose)}`
  }
  return `${tag}\n${html}`
}

function safeResolveUnder(rootDir, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const normalizedRoot = resolve(rootDir)
  const target = resolve(normalizedRoot, decoded.replace(/^\/+/, ''))
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}/`)) {
    return null
  }
  return target
}

function decodeSlugParam(rawSlug) {
  try {
    return { slug: decodeURIComponent(rawSlug), error: null }
  } catch {
    return { slug: null, error: 'Invalid Cell slug encoding' }
  }
}

function createOpenPlcProbe(openplc) {
  let cachedClient = null

  return async function probeLiveRuntime(runtimeState) {
    if (!openplc?.url) return { ...runtimeState }
    const client = cachedClient ?? new OpenPlcClient(openplc.url, { pollIntervals: openplc.pollIntervals })
    try {
      const verRes = await client.request('GET', 'version', { timeoutMs: 800 })
      if (verRes.status !== 200 || !verRes.body?.version) {
        return { ...runtimeState, plcStatus: 'OFFLINE' }
      }
      runtimeState.version = verRes.body.version

      let statusRes = await client.request('GET', 'status', { timeoutMs: 800 })
      if (statusRes.status === 401 || statusRes.status === 403) {
        await client.login(openplc.username, openplc.password)
        cachedClient = client
        statusRes = await client.request('GET', 'status', { timeoutMs: 800 })
      }
      if (statusRes.status === 200 && statusRes.body?.status) {
        runtimeState.plcStatus = String(statusRes.body.status)
      }
      return { ...runtimeState }
    } catch {
      return { ...runtimeState, plcStatus: 'OFFLINE' }
    }
  }
}

export async function createDemoPortalServer({
  repoRoot = REPO_ROOT,
  oipDistDir = resolve(repoRoot, 'Open-Industry-Project', 'dist'),
  generatedCellsDir = process.env.PORTAL_CELLS_DIR || null,
  accessToken = process.env.DEMO_ACCESS_TOKEN,
  httpHost = '127.0.0.1',
  httpPort = 3000,
  modbusListenHost = process.env.MODBUS_LISTEN_HOST || '127.0.0.1',
  modbusListenPort = 5020,
  leaseTimeoutMs = DEFAULT_LEASE_TIMEOUT_MS,
  dailyGenerationCap = process.env.DAILY_GENERATION_CAP !== undefined
    ? Number(process.env.DAILY_GENERATION_CAP)
    : DEFAULT_DAILY_GENERATION_CAP,
  generateCellFn = undefined,
  openplc = {
    url: process.env.OPENPLC_URL || null,
    oipModbusHost: process.env.OIP_MODBUS_HOST || undefined,
    username: process.env.OPENPLC_USERNAME || 'openplc',
    password: process.env.OPENPLC_PASSWORD || 'openplc',
    pollIntervals: undefined,
  },
  now = () => Date.now(),
  forceSecureCookies = false,
} = {}) {
  const plcConfig = {
    url: openplc?.url ?? null,
    oipModbusHost: openplc?.oipModbusHost,
    username: openplc?.username || 'openplc',
    password: openplc?.password || 'openplc',
    pollIntervals: openplc?.pollIntervals,
  }

  const auth = createSessionAuth({ accessToken, forceSecureCookies })
  const cellStore = createCellStore({ repoRoot, generatedCellsDir })
  const bridgeScriptBytes = readFileSync(join(PORTAL_DIR, 'oip-bridge.js'))
  const recentEvents = []
  const recordEvent = (message) => {
    const stamp = new Date(now()).toISOString().slice(11, 19)
    recentEvents.unshift(`${stamp} · ${message}`)
    if (recentEvents.length > 20) recentEvents.pop()
  }

  const generation = createGenerationManager({
    cellStore,
    generateCellFn,
    dailyCap: dailyGenerationCap,
    now,
    onEvent: recordEvent,
  })

  const runtimeState = {
    activeCell: null,
    plcStatus: plcConfig.url ? 'CHECKING' : 'OFFLINE',
    version: null,
    md5: null,
    lastDeployedAt: null,
  }
  const probeOpenPlc = createOpenPlcProbe(plcConfig)

  const bridge = await createModbusBridge({
    listenHost: modbusListenHost,
    listenPort: modbusListenPort,
    leaseTimeoutMs,
    now,
    onEvent: recordEvent,
  })
  const leaseMins = Math.max(1, Math.round(leaseTimeoutMs / 60_000))
  recordEvent(`Demo Portal online (Modbus TCP :${bridge.tcpPort}, strict ${leaseMins}m lease)`)

  async function handleAuthRoutes(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      const raw = (await readRequestBody(req)).toString('utf8')
      const token = new URLSearchParams(raw).get('token') ?? ''
      if (!auth.verifyToken(token)) {
        sendHtml(res, 401, renderLoginPage({ errorMessage: 'Invalid passphrase. Please try again.' }))
        return true
      }
      res.writeHead(302, {
        location: '/',
        'set-cookie': auth.issueCookie(req),
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }

    if (req.method === 'GET' && url.searchParams.has('token')) {
      const candidate = url.searchParams.get('token') ?? ''
      if (!auth.verifyToken(candidate)) {
        if (url.pathname.startsWith('/api/')) {
          sendJson(res, 401, { error: 'Invalid access token' })
        } else {
          sendHtml(res, 401, renderLoginPage({ errorMessage: 'Invalid or expired access token.' }))
        }
        return true
      }
      url.searchParams.delete('token')
      const cleanQuery = url.searchParams.toString()
      const location = `${url.pathname}${cleanQuery ? `?${cleanQuery}` : ''}`
      res.writeHead(302, {
        location,
        'set-cookie': auth.issueCookie(req),
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }

    return false
  }

  async function handleApiRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const liveOpenPlc = await probeOpenPlc(runtimeState)
      sendJson(res, 200, {
        ok: true,
        openplc: liveOpenPlc,
        bridge: bridge.status(),
        generation: generation.status(),
        events: recentEvents,
      })
      return true
    }

    if (url.pathname === '/api/generate/events') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Use GET for generation event stream' }, { allow: 'GET' })
        return true
      }
      generation.subscribe(req, res)
      return true
    }

    if (url.pathname === '/api/generate') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Use POST to start Cell generation' }, { allow: 'POST' })
        return true
      }
      let raw
      try {
        raw = (await readRequestBody(req)).toString('utf8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Request body error'
        sendJson(res, msg === 'Request body too large' ? 413 : 400, { error: msg })
        return true
      }
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON request body' })
        return true
      }
      const result = generation.start({ prompt: body?.prompt, name: body?.name })
      sendJson(res, result.status, result)
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/cells') {
      sendJson(res, 200, { cells: cellStore.listCells() })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/proof') {
      const proofMdPath = join(repoRoot, 'docs', 'orchestration-proof.md')
      const proofJsonPath = join(repoRoot, 'docs', 'orchestration-proof.json')
      if (!existsSync(proofMdPath) || !existsSync(proofJsonPath)) {
        sendJson(res, 404, { error: 'Committed orchestration proof not found' })
        return true
      }
      sendJson(res, 200, {
        markdown: readFileSync(proofMdPath, 'utf8'),
        json: JSON.parse(readFileSync(proofJsonPath, 'utf8')),
      })
      return true
    }

    const deployMatch = /^\/api\/cells\/([^/]+)\/deploy$/.exec(url.pathname)
    if (deployMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Use POST to deploy a Cell' }, { allow: 'POST' })
        return true
      }
      const { slug, error: decodeErr } = decodeSlugParam(deployMatch[1])
      if (decodeErr) {
        sendJson(res, 400, { error: decodeErr })
        return true
      }
      const entry = cellStore.resolveCellEntry(slug)
      if (entry.error) {
        sendJson(res, entry.status ?? 404, { error: entry.error })
        return true
      }
      if (!existsSync(entry.stPath) || !existsSync(entry.modbusMasterPath)) {
        sendJson(res, 400, { error: `Cell "${slug}" is missing PLC artifacts` })
        return true
      }
      if (!plcConfig.url) {
        sendJson(res, 503, { error: 'OpenPLC runtime URL (OPENPLC_URL) is not configured' })
        return true
      }

      const deployed = await deployProgram({
        stPath: entry.stPath,
        modbusMasterPath: entry.modbusMasterPath,
        runtimeUrl: plcConfig.url,
        oipModbusHost: plcConfig.oipModbusHost,
        username: plcConfig.username,
        password: plcConfig.password,
        startAfterDeploy: true,
        pollIntervals: plcConfig.pollIntervals,
      })

      runtimeState.activeCell = slug
      runtimeState.plcStatus = deployed.plcStatus
      runtimeState.version = deployed.version
      runtimeState.md5 = deployed.md5
      runtimeState.lastDeployedAt = new Date(now()).toISOString()
      recordEvent(`Deployed "${slug}" to OpenPLC ${deployed.version} (${deployed.plcStatus})`)

      sendJson(res, 200, {
        ok: true,
        slug,
        version: deployed.version,
        md5: deployed.md5,
        compilationStatus: deployed.compilationStatus,
        plcStatus: deployed.plcStatus,
        launchUrl: `/app/?cell=${encodeURIComponent(slug)}`,
      })
      return true
    }

    const oipFolderMatch = /^\/api\/cells\/([^/]+)\/oip-folder$/.exec(url.pathname)
    if (oipFolderMatch) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'OIP folder endpoint is read-only' }, { allow: 'GET' })
        return true
      }
      const { slug, error: decodeErr } = decodeSlugParam(oipFolderMatch[1])
      if (decodeErr) {
        sendJson(res, 400, { error: decodeErr })
        return true
      }
      const bundle = cellStore.readOipFolderBundle(slug)
      if (bundle.error) {
        sendJson(res, bundle.status ?? 404, { error: bundle.error })
        return true
      }
      sendJson(res, 200, bundle)
      return true
    }

    const cellDetailMatch = /^\/api\/cells\/([^/]+)$/.exec(url.pathname)
    if (cellDetailMatch) {
      const { slug, error: decodeErr } = decodeSlugParam(cellDetailMatch[1])
      if (decodeErr) {
        sendJson(res, 400, { error: decodeErr })
        return true
      }
      if (req.method === 'GET') {
        const details = cellStore.getCellDetails(slug)
        if (details.error) {
          sendJson(res, details.status ?? 404, { error: details.error })
          return true
        }
        sendJson(res, 200, details)
        return true
      }
      if (req.method === 'DELETE') {
        const result = cellStore.deleteCell(slug)
        if (result.error) {
          sendJson(res, result.status ?? 404, { error: result.error })
          return true
        }
        if (runtimeState.activeCell === slug) {
          runtimeState.activeCell = null
        }
        recordEvent(`Deleted generated Cell "${slug}"`)
        sendJson(res, 200, result)
        return true
      }
    }

    return false
  }

  function handleOipRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/oip-bridge.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        ...OIP_COI_HEADERS,
      })
      res.end(bridgeScriptBytes)
      return true
    }

    if (
      req.method === 'GET' &&
      (url.pathname === '/app' || url.pathname === '/app/' || url.pathname === '/app/index.html')
    ) {
      const indexPath = join(oipDistDir, 'app', 'index.html')
      if (!existsSync(indexPath)) {
        sendJson(res, 503, { error: 'OIP static build (dist/app/index.html) not found' })
        return true
      }
      const html = injectPreBootBridge(readFileSync(indexPath, 'utf8'))
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...OIP_COI_HEADERS,
      })
      res.end(html)
      return true
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const resolvedAsset = safeResolveUnder(oipDistDir, url.pathname)
      if (!resolvedAsset) {
        sendJson(res, 400, { error: 'Invalid asset path' })
        return true
      }
      if (existsSync(resolvedAsset) && statSync(resolvedAsset).isFile()) {
        const ext = extname(resolvedAsset).toLowerCase()
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
        const isImmutable =
          url.pathname.startsWith('/assets/') || url.pathname.startsWith('/part-assets/')
        res.writeHead(200, {
          'content-type': contentType,
          'cache-control': isImmutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
          ...OIP_COI_HEADERS,
        })
        res.end(req.method === 'HEAD' ? undefined : readFileSync(resolvedAsset))
        return true
      }
    }

    return false
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host || '127.0.0.1'}`)

      if (await handleAuthRoutes(req, res, url)) return

      if (!auth.hasValidSession(req)) {
        if (url.pathname.startsWith('/api/')) {
          sendJson(res, 401, { error: 'Authentication required' })
        } else {
          sendHtml(res, 401, renderLoginPage())
        }
        return
      }

      if (await handleApiRoutes(req, res, url)) return

      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(res, 200, renderConsolePage())
        return
      }

      if (handleOipRoutes(req, res, url)) return

      sendJson(res, 404, { error: 'Not found' })
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || '127.0.0.1'}`)
    if (!auth.hasValidSession(req)) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    if (url.pathname !== '/ws/modbus') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    const ws = acceptWebSocket(req, socket, head)
    if (ws) bridge.handleWebSocket(ws)
  })

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(httpPort, httpHost, () => resolvePromise())
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : httpPort

  return {
    httpPort: actualPort,
    modbusPort: bridge.tcpPort,
    baseUrl: `http://${httpHost}:${actualPort}`,
    checkBridgeExpiry: () => bridge.checkExpiry(),
    close: async () => {
      generation.close()
      await bridge.close()
      await new Promise((resolvePromise) => {
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      })
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const httpHost = process.env.HOST || '0.0.0.0'
  const httpPort = Number(process.env.PORT || 3000)
  const modbusListenHost = process.env.MODBUS_LISTEN_HOST || '0.0.0.0'
  const modbusListenPort = Number(process.env.MODBUS_LISTEN_PORT || 5020)
  const leaseTimeoutMs = Number(process.env.MODBUS_LEASE_TIMEOUT_MS || DEFAULT_LEASE_TIMEOUT_MS)

  createDemoPortalServer({
    httpHost,
    httpPort,
    modbusListenHost,
    modbusListenPort,
    leaseTimeoutMs,
    oipDistDir: process.env.OIP_DIST_DIR || resolve(REPO_ROOT, 'Open-Industry-Project', 'dist'),
    generatedCellsDir: process.env.PORTAL_CELLS_DIR || null,
    dailyGenerationCap:
      process.env.DAILY_GENERATION_CAP !== undefined
        ? Number(process.env.DAILY_GENERATION_CAP)
        : DEFAULT_DAILY_GENERATION_CAP,
    openplc: {
      url: process.env.OPENPLC_URL || 'https://127.0.0.1:8443',
      oipModbusHost: process.env.OIP_MODBUS_HOST || undefined,
      username: process.env.OPENPLC_USERNAME || 'openplc',
      password: process.env.OPENPLC_PASSWORD || 'openplc',
    },
    forceSecureCookies: process.env.FORCE_SECURE_COOKIES === '1',
  })
    .then((portal) => {
      console.log(
        `[demo-portal] Listening on ${portal.baseUrl} (Modbus TCP bridge :${portal.modbusPort})`,
      )
      const shutdown = async () => {
        await portal.close()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
