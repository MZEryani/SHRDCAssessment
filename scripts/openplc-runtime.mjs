import { request as httpsRequest } from 'node:https'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * HTTP client for the OpenPLC Runtime v4.1 REST API over HTTPS.
 */
export class OpenPlcClient {
  #token = null

  constructor(baseUrl = 'https://127.0.0.1:8443', { pollIntervals = {} } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    const { readyMs = 500, compileMs = 1000, statusMs = 250 } = pollIntervals ?? {}
    this.pollIntervals = { readyMs, compileMs, statusMs }
  }

  request(method, path, { json, body, headers = {}, timeoutMs = 15000 } = {}) {
    const url = new URL(`${this.baseUrl}/api/${path}`)
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body
    const reqHeaders = { ...headers }
    if (json !== undefined) reqHeaders['content-type'] = 'application/json'
    if (payload !== undefined) reqHeaders['content-length'] = String(Buffer.byteLength(payload))
    if (this.#token) reqHeaders.authorization = `Bearer ${this.#token}`

    return new Promise((resolvePromise, reject) => {
      const req = httpsRequest(
        url,
        { method, headers: reqHeaders, rejectUnauthorized: false, timeout: timeoutMs },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed = text
            try {
              parsed = JSON.parse(text)
            } catch {
              // Keep raw text for non-JSON responses
            }
            resolvePromise({ status: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error(`${method} ${url.pathname} timed out after ${timeoutMs}ms`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  async #ok(method, path, opts) {
    const res = await this.request(method, path, opts)
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${method} /api/${path} failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`)
    }
    return res.body
  }

  async waitReady(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    let lastError = 'no response'
    while (Date.now() < deadline) {
      try {
        const res = await this.request('GET', 'version', { timeoutMs: 3000 })
        if (res.status === 200 && res.body?.version) return res.body.version
        lastError = `HTTP ${res.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      await sleep(this.pollIntervals.readyMs)
    }
    throw new Error(`OpenPLC runtime at ${this.baseUrl} not ready after ${timeoutMs}ms (${lastError})`)
  }

  async login(username, password) {
    let created = false
    const users = await this.request('GET', 'get-users-info')
    if (users.status === 404 || users.body?.msg === 'No users found') {
      await this.#ok('POST', 'create-user', { json: { username, password } })
      created = true
    }
    const res = await this.request('POST', 'login', { json: { username, password } })
    if (res.status !== 200 || !res.body?.access_token) {
      throw new Error(`OpenPLC login failed for "${username}" (HTTP ${res.status}): ${JSON.stringify(res.body)}`)
    }
    this.#token = res.body.access_token
    return { created }
  }

  status() {
    return this.#ok('GET', 'status')
  }

  stop() {
    return this.#ok('GET', 'stop-plc')
  }

  start() {
    return this.#ok('GET', 'start-plc')
  }

  compilationStatus() {
    return this.#ok('GET', 'compilation-status')
  }

  async uploadZip(zipBuffer) {
    const boundary = `----openplc${Math.random().toString(16).slice(2)}`
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="program.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      zipBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await this.#ok('POST', 'upload-file', {
      body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      timeoutMs: 60000,
    })
    if (res.UploadFileFail) {
      throw new Error(`OpenPLC upload refused: ${res.UploadFileFail}`)
    }
    return res
  }

  async waitCompilation(timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const s = await this.compilationStatus()
      if (s.status === 'SUCCESS') return s
      if (s.status === 'FAILED') {
        const logs = Array.isArray(s.logs) ? s.logs.join('') : String(s.logs ?? '')
        throw new Error(`OpenPLC compilation failed (exit ${s.exit_code}):\n${logs.trim()}`)
      }
      await sleep(this.pollIntervals.compileMs)
    }
    throw new Error(`OpenPLC compilation timed out after ${timeoutMs}ms`)
  }

  async waitStatus(expected, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      const res = await this.status()
      last = String(res.status ?? '')
      if (last.includes(expected)) return last
      await sleep(this.pollIntervals.statusMs)
    }
    throw new Error(`OpenPLC did not reach ${expected} within ${timeoutMs}ms (last: ${last})`)
  }
}

/**
 * Deploy a compiled program.zip bundle to an OpenPLC Runtime v4.1 instance.
 */
export async function deployBundle({
  zipBuffer,
  md5,
  runtimeUrl = process.env.OPENPLC_URL || 'https://127.0.0.1:8443',
  username = process.env.OPENPLC_USER ?? 'openplc',
  password = process.env.OPENPLC_PASSWORD ?? 'openplc',
  startAfterDeploy = true,
  client,
  pollIntervals,
}) {
  const activeClient = client ?? new OpenPlcClient(runtimeUrl, { pollIntervals })
  const version = await activeClient.waitReady()
  const { created } = await activeClient.login(username, password)
  await activeClient.stop()
  await activeClient.uploadZip(zipBuffer)
  const build = await activeClient.waitCompilation()
  let plcStatus = 'STOPPED'
  if (startAfterDeploy) {
    await activeClient.start()
    plcStatus = await activeClient.waitStatus('RUNNING')
  }
  return {
    stop: () => activeClient.stop(),
    version,
    md5,
    userCreated: created,
    compilationStatus: build.status,
    plcStatus,
  }
}
