import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_STRUCPP_DIR = join(REPO_ROOT, '.tools', 'strucpp', 'strucpp')

/**
 * Resolve the platform-specific STruC++ compiler binary inside a STruC++ directory.
 */
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
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries
}

/**
 * Package all files under rootDir into a deterministic DEFLATE ZIP buffer.
 */
export function createZipBuffer(rootDir) {
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
