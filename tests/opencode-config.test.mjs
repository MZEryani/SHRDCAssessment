import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OPENCODE_DIR = join(REPO_ROOT, '.opencode')

function runJson(cmd, args) {
  const out = execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return JSON.parse(out)
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, 'Expected YAML frontmatter delimited by ---')
  const fields = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/)
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return fields
}

function modelSpec(agent) {
  return `${agent.model?.providerID ?? agent.model?.provider}/${agent.model?.modelID ?? agent.model?.id}`
}

function isGitIgnored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: REPO_ROOT })
    return true
  } catch {
    return false
  }
}

describe('OpenCode progressive-disclosure skills, tiered agents, and secret ignore rules', () => {
  it('discovers repo opencode.json with .opencode/instructions.md and the .opencode directory cleanly', () => {
    const sources = runJson('opencode', ['debug', 'config', '--standalone'])
    const foundDir = sources.some(
      (src) => src.type === 'directory' && resolve(src.path) === OPENCODE_DIR,
    )
    assert.equal(foundDir, true, `Expected ${OPENCODE_DIR} in opencode debug config output`)

    const repoConfigPath = join(REPO_ROOT, 'opencode.json')
    const configDoc = sources.find(
      (src) => src.type === 'document' && resolve(src.path) === repoConfigPath,
    )
    assert.ok(configDoc, `Expected ${repoConfigPath} in opencode debug config output`)
    assert.ok(
      Array.isArray(configDoc.info?.instructions) &&
        configDoc.info.instructions.includes('.opencode/instructions.md'),
      `Expected opencode.json instructions to include ".opencode/instructions.md", got: ${JSON.stringify(configDoc.info)}`,
    )
    assert.equal(
      existsSync(join(OPENCODE_DIR, 'instructions.md')),
      true,
      'Missing .opencode/instructions.md referenced by opencode.json',
    )
  })

  it('defines three focused progressive-disclosure skills with valid frontmatter and disclosed references', () => {
    const expectedSkills = [
      { name: 'openplc-st', reference: 'strucpp-modbus-reference.md' },
      { name: 'oip-scene', reference: 'oip-cli-reference.md' },
      { name: 'plc-oip-verify', reference: 'verification-seams.md' },
    ]

    for (const { name, reference } of expectedSkills) {
      const skillPath = join(OPENCODE_DIR, 'skills', name, 'SKILL.md')
      const refPath = join(OPENCODE_DIR, 'skills', name, reference)
      assert.equal(existsSync(skillPath), true, `Missing skill file: ${skillPath}`)
      assert.equal(existsSync(refPath), true, `Missing disclosed reference file: ${refPath}`)

      const content = readFileSync(skillPath, 'utf8')
      const fm = parseFrontmatter(content)
      assert.equal(fm.name, name, `Skill frontmatter name must match folder "${name}"`)
      assert.ok(
        fm.description && fm.description.length >= 20 && fm.description.length <= 260,
        `Skill "${name}" description must be concise and non-empty`,
      )
      assert.ok(
        content.includes(reference),
        `Skill "${name}" SKILL.md must point to disclosed reference "${reference}"`,
      )
    }
  })

  it('discovers tiered Orchestrator (Gemini 4) and worker (Gemini 3.8 Flash) agents via opencode debug agents', () => {
    const agents = runJson('opencode', ['debug', 'agents', '--standalone'])
    const byId = new Map(agents.map((a) => [a.id, a]))

    const orchestrator = byId.get('orchestrator')
    assert.ok(orchestrator, 'Expected custom agent "orchestrator" to be discovered')
    assert.equal(orchestrator.mode, 'primary')
    assert.equal(modelSpec(orchestrator), 'google/gemini-4-neon')

    const workers = [
      { id: 'plc-coder', skill: 'openplc-st' },
      { id: 'oip-builder', skill: 'oip-scene' },
      { id: 'test-engineer', skill: 'plc-oip-verify' },
    ]

    for (const { id, skill } of workers) {
      const worker = byId.get(id)
      assert.ok(worker, `Expected custom worker agent "${id}" to be discovered`)
      assert.equal(worker.mode, 'all', `Worker "${id}" must declare mode: all for CLI dispatch`)
      assert.equal(modelSpec(worker), 'google/gemini-3.8-flash')
      assert.notEqual(
        modelSpec(worker),
        modelSpec(orchestrator),
        `Worker "${id}" must use a faster/lower-cost model than orchestrator`,
      )

      const skillPerms = (worker.permissions ?? []).filter((p) => p.action === 'skill')
      const allowsOwnSkill = skillPerms.some(
        (p) => p.resource === skill && p.effect === 'allow',
      )
      const deniesOtherSkills = skillPerms.some(
        (p) => p.resource === '*' && p.effect === 'deny',
      )
      assert.equal(
        allowsOwnSkill && deniesOtherSkills,
        true,
        `Worker "${id}" must restrict skill loading to "${skill}" for progressive disclosure`,
      )
    }
  })

  it('ignores local environment and secret files in git while keeping .env.example trackable', () => {
    const mustIgnore = [
      '.env',
      '.env.local',
      '.env.production',
      '.opencode/auth.json',
      'local-secret.key',
      'local-cert.pem',
    ]

    for (const file of mustIgnore) {
      assert.equal(isGitIgnored(file), true, `Expected "${file}" to be ignored by .gitignore`)
    }
    assert.equal(isGitIgnored('.env.example'), false, 'Expected ".env.example" to remain trackable')
  })

  it('keeps agent definitions and skills completely generic with zero Conveyor-Cell prompt leakage', () => {
    const walkMarkdown = (dir) => {
      const files = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) files.push(...walkMarkdown(full))
        else if (entry.endsWith('.md')) files.push(full)
      }
      return files
    }

    const forbiddenPatterns = [
      /conveyor-cell/i,
      /ConveyorCell/,
      /BATCH_TARGET/,
      /DWELL_TIME/,
      /JAM_THRESHOLD_TIME/,
      /\bbelt_1\b/,
      /\bspawner_1\b/,
      /\bphotoeye_1\b/,
      /\bbatch_indicator\b/,
      /conveyor_cell_modbus_master/,
      /0\.35,1\.25,0/,
      /\b0\.085\b/,
      /\b6\.17\b/,
      /\b0\.457\b/,
      /\bReset_Count_PB\b/,
      /\bSpawner_Enable\b/,
      /\bDwell_Light\b/,
      /\bBox_Count\b/,
      /\bPhotoEye\b/,
    ]

    const mdFiles = [
      join(OPENCODE_DIR, 'instructions.md'),
      ...walkMarkdown(join(OPENCODE_DIR, 'agents')),
      ...walkMarkdown(join(OPENCODE_DIR, 'skills')),
    ]
    assert.ok(mdFiles.length > 0, 'Expected agent and skill markdown files to exist')

    for (const file of mdFiles) {
      const text = readFileSync(file, 'utf8')
      for (const rx of forbiddenPatterns) {
        assert.doesNotMatch(
          text,
          rx,
          `Found leaked Conveyor-Cell reference (${rx}) in ${file}`,
        )
      }
    }
  })
})
