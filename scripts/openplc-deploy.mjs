#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_STRUCPP_DIR = join(REPO_ROOT, '.tools', 'strucpp', 'strucpp')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class OpenPlcClient {
  #token = null

  constructor(baseUrl = 'https://127.0.0.1:8443') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  request(method, path, { json, body, headers = {}, timeoutMs = 15000 } = {}) {
    const url = new URL(`${this.baseUrl}/api/${path}`)
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body
    const reqHeaders = { ...headers }
    if (json !== undefined) reqHeaders['content-type'] = 'application/json'
    if (payload) reqHeaders['content-length'] = String(payload.length)
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
      await sleep(500)
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
      await sleep(1000)
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
      await sleep(250)
    }
    throw new Error(`OpenPLC did not reach ${expected} within ${timeoutMs}ms (last: ${last})`)
  }
}

export function resolveStrucppBin(strucppDir = DEFAULT_STRUCPP_DIR) {
  return join(strucppDir, process.platform === 'win32' ? 'strucpp.exe' : 'strucpp')
}

function collectFiles(dir, rootDir = dir) {
  const entries = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      entries.push(...collectFiles(fullPath, rootDir))
    } else if (entry.isFile()) {
      entries.push({
        name: relative(rootDir, fullPath).replaceAll('\\', '/'),
        data: readFileSync(fullPath),
      })
    }
  }
  return entries
}

function createZipBuffer(rootDir) {
  const files = collectFiles(rootDir)
  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data)
    const crc = crc32(data) >>> 0

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(8, 8) // deflate
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localChunks.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(8, 10) // deflate
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralChunks.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + compressed.length
  }

  const centralSize = centralChunks.reduce((sum, buf) => sum + buf.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, ...centralChunks, eocd])
}

/**
 * Compile an IEC 61131-3 .st file with STruC++ and package a Runtime v4 program.zip buffer.
 */
export function buildProgramZip({ stPath, modbusMasterPath, strucppDir = DEFAULT_STRUCPP_DIR }) {
  const strucppBin = resolveStrucppBin(strucppDir)
  const runtimeIncSrc = join(strucppDir, 'runtime', 'include')
  if (!existsSync(strucppBin)) {
    throw new Error(`STruC++ binary not found at ${strucppBin}`)
  }
  if (!existsSync(runtimeIncSrc)) {
    throw new Error(`STruC++ runtime headers not found at ${runtimeIncSrc}`)
  }

  const stSource = readFileSync(stPath, 'utf8')
  const md5 = createHash('md5').update(stSource).digest('hex')

  const workDir = mkdtempSync(join(tmpdir(), 'openplc-bundle-'))
  const bundleDir = join(workDir, 'bundle')

  try {
    cpSync(runtimeIncSrc, join(bundleDir, 'strucpp_runtime', 'include'), { recursive: true })
    execFileSync(strucppBin, [resolve(stPath), '--debug', '-o', join(bundleDir, 'generated.cpp')], {
      stdio: 'pipe',
    })

    writeFileSync(join(bundleDir, 'defines.h'), `#define PROGRAM_MD5 "${md5}"\n`, 'utf8')

    // Standalone strucpp CLI does not emit generated_debug.cpp; provide empty debug/retain tables
    // so runtime_v4_entry.cpp links cleanly with external symbol visibility.
    const debugCppPath = join(bundleDir, 'generated_debug.cpp')
    if (!existsSync(debugCppPath)) {
      writeFileSync(
        debugCppPath,
        [
          '#include "debug_table.hpp"',
          'namespace strucpp { namespace debug {',
          'const Entry* const debug_arrays[] STRUCPP_DEBUG_FLASH = { nullptr };',
          'const uint16_t debug_array_counts[] STRUCPP_DEBUG_FLASH = { 0 };',
          'const uint8_t debug_array_count = 0;',
          'const RetainVar retain_vars[] STRUCPP_DEBUG_FLASH = { {0, 0} };',
          'const uint16_t retain_var_count = 0;',
          'const uint32_t retain_layout_hash = 0;',
          '} }',
          '',
        ].join('\n'),
        'utf8',
      )
    }

    if (modbusMasterPath) {
      cpSync(resolve(modbusMasterPath), join(bundleDir, 'conf', 'modbus_master.json'))
    }

    return { zipBuffer: createZipBuffer(bundleDir), md5 }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

export async function deployProgram({
  stPath,
  modbusMasterPath,
  runtimeUrl = process.env.OPENPLC_URL ?? 'https://127.0.0.1:8443',
  username = process.env.OPENPLC_USER ?? 'openplc',
  password = process.env.OPENPLC_PASSWORD ?? 'openplc',
  startAfterDeploy = true,
}) {
  const { zipBuffer, md5 } = buildProgramZip({ stPath, modbusMasterPath })
  const client = new OpenPlcClient(runtimeUrl)
  const version = await client.waitReady()
  const { created } = await client.login(username, password)
  await client.stop()
  await client.uploadZip(zipBuffer)
  const build = await client.waitCompilation()
  let plcStatus = 'STOPPED'
  if (startAfterDeploy) {
    await client.start()
    plcStatus = await client.waitStatus('RUNNING')
  }
  return {
    client,
    version,
    md5,
    userCreated: created,
    compilationStatus: build.status,
    plcStatus,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stPath, modbusMasterPath] = process.argv.slice(2)
  if (!stPath) {
    console.error('Usage: node scripts/openplc-deploy.mjs <program.st> [modbus_master.json]')
    process.exit(1)
  }
  deployProgram({ stPath, modbusMasterPath, startAfterDeploy: true })
    .then((res) => {
      console.log(
        `Deployed ${stPath} (md5=${res.md5.slice(0, 8)}) to OpenPLC ${res.version}: compile=${res.compilationStatus}, status=${res.plcStatus}`,
      )
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
