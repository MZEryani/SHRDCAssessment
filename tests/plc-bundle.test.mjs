import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'
import {
  buildProgramZip,
  createZipBuffer,
  DEFAULT_STRUCPP_DIR,
  resolveStrucppBin,
} from '../scripts/plc-bundle.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function findEocdOffset(buf) {
  const minOffset = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && buf.readUInt16LE(i + 20) === buf.length - i - 22) {
      return i
    }
  }
  throw new Error('ZIP End of Central Directory (0x06054b50) not found')
}

function readZipEntries(buf) {
  assert.ok(Buffer.isBuffer(buf), 'ZIP output must be a Buffer')
  const eocdOffset = findEocdOffset(buf)
  const diskEntries = buf.readUInt16LE(eocdOffset + 8)
  const totalEntries = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)
  assert.equal(diskEntries, totalEntries)
  assert.ok(centralOffset + centralSize <= eocdOffset)

  const entries = []
  const files = new Map()
  let pos = centralOffset

  for (let i = 0; i < totalEntries; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, `Expected central directory signature at ${pos}`)
    const method = buf.readUInt16LE(pos + 10)
    const cdCrc = buf.readUInt32LE(pos + 16)
    const cdCompSize = buf.readUInt32LE(pos + 20)
    const cdUncompSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localHeaderOffset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    pos += 46 + nameLen + extraLen + commentLen

    assert.equal(
      buf.readUInt32LE(localHeaderOffset),
      0x04034b50,
      `Expected local file header signature at ${localHeaderOffset} for ${name}`,
    )
    const lfhMethod = buf.readUInt16LE(localHeaderOffset + 8)
    const lfhCrc = buf.readUInt32LE(localHeaderOffset + 14)
    const lfhCompSize = buf.readUInt32LE(localHeaderOffset + 18)
    const lfhUncompSize = buf.readUInt32LE(localHeaderOffset + 22)
    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26)
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28)
    const lfhName = buf
      .subarray(localHeaderOffset + 30, localHeaderOffset + 30 + lfhNameLen)
      .toString('utf8')

    assert.equal(lfhName, name)
    assert.equal(lfhMethod, method)
    assert.equal(lfhCrc, cdCrc)
    assert.equal(lfhCompSize, cdCompSize)
    assert.equal(lfhUncompSize, cdUncompSize)

    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen
    const compressedData = buf.subarray(dataStart, dataStart + lfhCompSize)
    const data = method === 8 ? inflateRawSync(compressedData) : Buffer.from(compressedData)

    assert.equal(data.length, lfhUncompSize, `Size mismatch for ${name}`)
    assert.equal(crc32(data) >>> 0, lfhCrc, `CRC32 mismatch for ${name}`)

    const entry = {
      name,
      method,
      crc: lfhCrc,
      compressedSize: lfhCompSize,
      uncompressedSize: lfhUncompSize,
      data,
    }
    entries.push(entry)
    files.set(name, data)
  }

  assert.equal(pos, centralOffset + centralSize)
  return { entries, files }
}

describe('plc-bundle', () => {
  it('resolveStrucppBin returns platform binary path under default and custom directories', () => {
    assert.equal(DEFAULT_STRUCPP_DIR, join(REPO_ROOT, '.tools', 'strucpp', 'strucpp'))

    const expectedName = process.platform === 'win32' ? 'strucpp.exe' : 'strucpp'
    assert.equal(resolveStrucppBin(), join(DEFAULT_STRUCPP_DIR, expectedName))

    const customDir = join(REPO_ROOT, 'custom', 'strucpp-dir')
    assert.equal(resolveStrucppBin(customDir), join(customDir, expectedName))

    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      assert.equal(resolveStrucppBin(customDir), join(customDir, 'strucpp.exe'))

      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      assert.equal(resolveStrucppBin(customDir), join(customDir, 'strucpp'))
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('createZipBuffer builds deterministic DEFLATE ZIP with POSIX paths and valid CRC32', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plc-bundle-zip-test-'))
    try {
      mkdirSync(join(tempDir, 'a', 'nested'), { recursive: true })
      mkdirSync(join(tempDir, 'a', 'b'), { recursive: true })

      const fixtures = [
        ['z.txt', Buffer.from('top-level file\n', 'utf8')],
        ['a/nested/one.txt', Buffer.from('nested utf8 payload ✓\n', 'utf8')],
        ['a/b/two.bin', Buffer.from([0x00, 0xff, 0x10, 0x20, 0x7f, 0x80])],
        ['empty.txt', Buffer.alloc(0)],
      ]

      for (const [relPath, content] of fixtures) {
        writeFileSync(join(tempDir, relPath), content)
      }

      const zipBuf1 = createZipBuffer(tempDir)
      const zipBuf2 = createZipBuffer(tempDir)
      assert.equal(Buffer.compare(zipBuf1, zipBuf2), 0, 'ZIP buffer should be deterministic')

      const { entries, files } = readZipEntries(zipBuf1)
      assert.deepEqual(
        entries.map((e) => e.name),
        ['a/b/two.bin', 'a/nested/one.txt', 'empty.txt', 'z.txt'],
      )
      for (const entry of entries) {
        assert.equal(entry.method, 8, `${entry.name} should use DEFLATE compression`)
        assert.equal(entry.name.includes('\\'), false, `${entry.name} must use POSIX separators`)
      }
      for (const [relPath, expected] of fixtures) {
        assert.deepEqual(files.get(relPath), expected, `Content mismatch for ${relPath}`)
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('buildProgramZip compiles conveyor-cell ST and packages runtime headers, MD5, debug symbols, and modbus_master.json', () => {
    const stPath = join(REPO_ROOT, 'scenes', 'conveyor-cell', 'plc', 'program.st')
    const modbusMasterPath = join(REPO_ROOT, 'openplc', 'conveyor_cell_modbus_master.json')
    const expectedMd5 = createHash('md5').update(readFileSync(stPath, 'utf8')).digest('hex')

    const { zipBuffer, md5 } = buildProgramZip({ stPath, modbusMasterPath })
    assert.equal(md5, expectedMd5)

    const { entries, files } = readZipEntries(zipBuffer)
    const names = entries.map((e) => e.name)

    assert.equal(files.get('defines.h')?.toString('utf8'), `#define PROGRAM_MD5 "${expectedMd5}"\n`)
    assert.ok(files.get('generated.cpp')?.length > 0, 'generated.cpp must be present and non-empty')
    assert.ok(files.get('generated.hpp')?.length > 0, 'generated.hpp must be present and non-empty')

    const debugCpp = files.get('generated_debug.cpp')?.toString('utf8') ?? ''
    assert.ok(
      debugCpp.includes('namespace strucpp') && debugCpp.includes('namespace debug'),
      'generated_debug.cpp must define strucpp::debug symbols',
    )

    const runtimeHeaders = names.filter((n) => n.startsWith('strucpp_runtime/include/'))
    assert.ok(runtimeHeaders.length > 0, 'ZIP must include strucpp_runtime/include/... headers')
    assert.ok(
      files.has('strucpp_runtime/include/iec_types.hpp'),
      'ZIP must include strucpp_runtime/include/iec_types.hpp',
    )
    assert.ok(
      files.has('strucpp_runtime/include/debug_table.hpp'),
      'ZIP must include strucpp_runtime/include/debug_table.hpp',
    )

    assert.equal(
      files.get('conf/modbus_master.json')?.toString('utf8'),
      readFileSync(modbusMasterPath, 'utf8'),
    )
  })

  it('buildProgramZip on tracer_bullet.st without modbusMasterPath omits conf/modbus_master.json', () => {
    const stPath = join(REPO_ROOT, 'openplc', 'tracer_bullet.st')
    const expectedMd5 = createHash('md5').update(readFileSync(stPath, 'utf8')).digest('hex')

    const { zipBuffer, md5 } = buildProgramZip({ stPath })
    assert.equal(md5, expectedMd5)

    const { files } = readZipEntries(zipBuffer)
    assert.equal(files.has('conf/modbus_master.json'), false)
    assert.equal(files.get('defines.h')?.toString('utf8'), `#define PROGRAM_MD5 "${expectedMd5}"\n`)
    assert.ok(files.get('generated.cpp')?.length > 0)
    assert.ok(files.get('generated.hpp')?.length > 0)
    assert.ok(files.has('generated_debug.cpp'))
    assert.ok(files.has('strucpp_runtime/include/iec_types.hpp'))
  })

  it('buildProgramZip throws when STruC++ binary is missing in nonexistent strucppDir', () => {
    const stPath = join(REPO_ROOT, 'openplc', 'tracer_bullet.st')
    const missingDir = join(REPO_ROOT, '.tools', 'nonexistent-strucpp-dir')

    assert.throws(
      () => buildProgramZip({ stPath, strucppDir: missingDir }),
      /STruC\+\+ binary not found/,
    )
  })

  it('buildProgramZip throws when runtime/include is missing inside strucppDir', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plc-bundle-no-runtime-'))
    try {
      const binName = process.platform === 'win32' ? 'strucpp.exe' : 'strucpp'
      writeFileSync(join(tempDir, binName), '')
      const stPath = join(REPO_ROOT, 'openplc', 'tracer_bullet.st')

      assert.throws(
        () => buildProgramZip({ stPath, strucppDir: tempDir }),
        /STruC\+\+ runtime headers not found/,
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('boundary check: plc-test.mjs imports ./plc-bundle.mjs without openplc-deploy.mjs, and plc-bundle.mjs has no network imports', async () => {
    const plcTestSrc = readFileSync(join(REPO_ROOT, 'scripts', 'plc-test.mjs'), 'utf8')
    assert.match(plcTestSrc, /from ['"]\.\/plc-bundle\.mjs['"]/)
    assert.equal(plcTestSrc.includes('openplc-deploy.mjs'), false)

    const plcBundleSrc = readFileSync(join(REPO_ROOT, 'scripts', 'plc-bundle.mjs'), 'utf8')
    assert.equal(plcBundleSrc.includes('node:https'), false)
    assert.equal(plcBundleSrc.includes('node:http'), false)

    const deployMod = await import('../scripts/openplc-deploy.mjs')
    assert.equal(deployMod.buildProgramZip, buildProgramZip)
    assert.equal(deployMod.resolveStrucppBin, resolveStrucppBin)
  })
})
