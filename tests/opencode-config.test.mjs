import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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
  it('discovers the repo .opencode configuration directory cleanly', () => {
    const sources = runJson('opencode', ['debug', 'config', '--standalone'])
    const found = sources.some(
      (src) => src.type === 'directory' && resolve(src.path) === OPENCODE_DIR,
    )
    assert.equal(found, true, `Expected ${OPENCODE_DIR} in opencode debug config output`)
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
})
