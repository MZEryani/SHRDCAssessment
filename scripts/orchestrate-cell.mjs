#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createLineSplitter,
  inspectNdjsonRetryLine,
  probeModelPair,
} from './opencode-probe.mjs'
import { createInitialState, transition } from './orchestration-machine.mjs'

export { inspectNdjsonRetryLine }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const GREENFIELD_FILES = [
  'openplc/io-contract.json',
  'openplc/conveyor_cell.st',
  'openplc/conveyor_cell_modbus_master.json',
  'scenes/conveyor-cell/plc/program.st',
  'scenes/conveyor-cell/scene.json',
  'tests/conveyor_cell.test.st',
]

export const WORKER_SPECS = [
  {
    agent: 'plc-coder',
    expectedSkill: 'openplc-st',
    ownedFiles: [
      'openplc/conveyor_cell.st',
      'openplc/conveyor_cell_modbus_master.json',
      'scenes/conveyor-cell/plc/program.st',
    ],
  },
  {
    agent: 'oip-builder',
    expectedSkill: 'oip-scene',
    ownedFiles: [
      'scenes/conveyor-cell/project.json',
      'scenes/conveyor-cell/scene.json',
    ],
  },
  {
    agent: 'test-engineer',
    expectedSkill: 'plc-oip-verify',
    ownedFiles: [
      'tests/conveyor_cell.test.st',
      'tests/conveyor-cell-e2e.test.mjs',
      'tests/tracer-modbus.test.mjs',
    ],
  },
]

function extractWorktreeFromSkillPart(part) {
  const skillDir = part?.state?.metadata?.metadata?.directory
  if (typeof skillDir === 'string') {
    const normalized = skillDir.replaceAll('\\', '/')
    if (normalized.includes('/.opencode/skills/')) {
      return normalized.split('/.opencode/skills/')[0]
    }
  }
  return null
}

function removeWorktrees(repoRoot, worktreePaths) {
  for (const wtPath of worktreePaths) {
    if (!wtPath) continue
    try {
      execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', wtPath], {
        stdio: 'pipe',
      })
    } catch {
      // Ignore if already removed
    }
  }
  execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'pipe' })
}

export function parseOpenCodeNdjson(rawOutput) {
  let worktreePath = null
  let sessionId = null
  const skillsLoaded = new Set()
  const toolsUsed = {}
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let costUsd = 0
  let finalText = ''
  let error = null

  for (const rawLine of rawOutput.split('\n')) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (!line) continue
    if (line.startsWith('worktree ')) {
      worktreePath = line.slice('worktree '.length).trim()
      continue
    }
    if (!line.startsWith('{')) continue

    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (event.sessionID && !sessionId) sessionId = event.sessionID

    if (event.type === 'tool_use' && event.part) {
      const tool = event.part.tool
      if (tool) toolsUsed[tool] = (toolsUsed[tool] ?? 0) + 1
      if (tool === 'skill' && event.part.state?.input?.id) {
        skillsLoaded.add(event.part.state.input.id)
        if (!worktreePath) {
          worktreePath = extractWorktreeFromSkillPart(event.part)
        }
      }
    } else if (event.type === 'step_finish' && event.part) {
      if (typeof event.part.cost === 'number') costUsd += event.part.cost
      const t = event.part.tokens
      if (t) {
        tokens.input += t.input ?? 0
        tokens.output += t.output ?? 0
        tokens.reasoning += t.reasoning ?? 0
        tokens.cacheRead += t.cache?.read ?? 0
        tokens.cacheWrite += t.cache?.write ?? 0
      }
    } else if (event.type === 'text' && event.part?.text) {
      finalText = event.part.text
    } else if (event.type === 'error' && event.error) {
      error = event.error.message ?? JSON.stringify(event.error)
    }
  }

  return {
    worktreePath,
    sessionId,
    skillsLoaded: [...skillsLoaded],
    toolsUsed,
    tokens,
    costUsd: Number(costUsd.toFixed(6)),
    finalText: finalText.trim(),
    error,
  }
}

function listWorktreePaths(repoRoot) {
  const out = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  })
  return new Set(
    out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim()),
  )
}

function stepMachine(machine, event) {
  const next = transition(machine, event)
  if (next.lastRejected) {
    throw new Error(`Orchestration state machine rejected ${event.type}: ${next.lastMessage}`)
  }
  return next
}

function runOpenCodeAsync({
  agent,
  model,
  worktreeName,
  prompt,
  cwd = REPO_ROOT,
  timeoutMs = 240000,
  maxRetryAttempts = 2,
}) {
  return new Promise((resolvePromise, reject) => {
    const args = ['run', '--standalone', '--auto', '--archived', '--format', 'json', '--agent', agent]
    if (worktreeName) args.push('--worktree', worktreeName)
    if (model) args.push('--model', model)
    args.push(prompt)

    const startedAt = new Date().toISOString()
    const startMs = performance.now()
    const child = spawn('opencode', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let abortedReason = null

    const abortRun = (reason) => {
      if (abortedReason) return
      abortedReason = reason
      if (!child.killed) child.kill('SIGTERM')
    }

    const timer = setTimeout(() => {
      abortRun(`Agent "${agent}" timed out after ${timeoutMs}ms`)
    }, timeoutMs)

    const splitter = createLineSplitter((line) => {
      const retryAbort = inspectNdjsonRetryLine(line, { maxRetryAttempts })
      if (retryAbort) abortRun(`Agent "${agent}" ${retryAbort}`)
    })

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdout += text
      splitter.push(text)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      splitter.flush()
      const finishedAt = new Date().toISOString()
      const durationMs = Math.round(performance.now() - startMs)
      const parsed = parseOpenCodeNdjson(`${stderr}\n${stdout}`)
      if (abortedReason) {
        reject(new Error(`${abortedReason} (tools=${JSON.stringify(parsed.toolsUsed)})`))
        return
      }
      if (code !== 0 || parsed.error) {
        reject(
          new Error(
            `OpenCode agent "${agent}" failed (exit ${code}): ${parsed.error ?? stderr.trim()}`,
          ),
        )
        return
      }
      resolvePromise({
        agent,
        model,
        startedAt,
        finishedAt,
        durationMs,
        ...parsed,
      })
    })
  })
}

function linkLocalToolchains(repoRoot, targetDir) {
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
  for (const dir of ['.tools', 'Open-Industry-Project']) {
    const src = join(repoRoot, dir)
    const dst = join(targetDir, dir)
    if (existsSync(src) && !existsSync(dst)) {
      symlinkSync(src, dst, symlinkType)
    }
  }
}

export function prepareGreenfieldBase({
  repoRoot = REPO_ROOT,
  runId,
  stripFiles = GREENFIELD_FILES,
}) {
  const baseBranch = `orchestrate/${runId}/base`
  const tempBase = mkdtempSync(join(tmpdir(), `orchestrate-base-${runId}-`))
  const baseWorktreePath = join(tempBase, 'base')

  execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'add', '-b', baseBranch, baseWorktreePath, 'HEAD'],
    { stdio: 'pipe' },
  )

  for (const relPath of stripFiles) {
    const full = join(baseWorktreePath, relPath)
    if (existsSync(full)) rmSync(full, { force: true })
  }

  execFileSync('git', ['-C', baseWorktreePath, 'add', '-A'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', baseWorktreePath, 'commit', '--no-verify', '-m', 'chore: clean greenfield base for orchestration'],
    { stdio: 'pipe' },
  )

  linkLocalToolchains(repoRoot, baseWorktreePath)

  const cleanup = () => {
    removeWorktrees(repoRoot, [baseWorktreePath])
    try {
      execFileSync('git', ['-C', repoRoot, 'branch', '-D', baseBranch], { stdio: 'pipe' })
    } catch {
      // Ignore if already deleted
    }
    rmSync(tempBase, { recursive: true, force: true })
  }

  return { baseBranch, baseWorktreePath, cleanup }
}

export function mergeWorkerBranches({ repoRoot, runId, workers, baseRef = 'HEAD' }) {
  const integrationBranch = `orchestrate/${runId}/integration`
  const tempBase = mkdtempSync(join(tmpdir(), `orchestrate-int-${runId}-`))
  const integrationWorktreePath = join(tempBase, 'integration')
  const createdBranches = [integrationBranch]
  const mergedBranches = []
  let conflicts = 0

  for (const worker of workers) {
    const branch = `orchestrate/${runId}/${worker.name}`
    createdBranches.push(branch)
    execFileSync('git', ['-C', worker.worktreePath, 'checkout', '-b', branch], { stdio: 'pipe' })
    if (baseRef !== 'HEAD') {
      // Align worker branch parent to baseRef while keeping worker's authored files intact
      execFileSync('git', ['-C', worker.worktreePath, 'reset', '--mixed', baseRef], {
        stdio: 'pipe',
      })
    }
    const existingOwned = (worker.ownedFiles ?? []).filter((f) =>
      existsSync(join(worker.worktreePath, f)),
    )
    if (existingOwned.length > 0) {
      execFileSync('git', ['-C', worker.worktreePath, 'add', '--', ...existingOwned], {
        stdio: 'pipe',
      })
    } else {
      execFileSync('git', ['-C', worker.worktreePath, 'add', '-A'], { stdio: 'pipe' })
    }
    const status = execFileSync(
      'git',
      ['-C', worker.worktreePath, 'diff', '--cached', '--name-only'],
      { encoding: 'utf8' },
    ).trim()
    const commitArgs = ['-C', worker.worktreePath, 'commit', '--no-verify', '-m', `chore: worker ${worker.name} output`]
    if (!status) commitArgs.push('--allow-empty')
    execFileSync('git', commitArgs, { stdio: 'pipe' })
    const sha = execFileSync('git', ['-C', worker.worktreePath, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const filesChanged = execFileSync(
      'git',
      ['-C', worker.worktreePath, 'diff', '--name-only', `${baseRef}..HEAD`],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    mergedBranches.push({
      worker: worker.name,
      branch,
      commitSha: sha,
      worktreePath: worker.worktreePath,
      filesChanged,
    })
  }

  execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'add', '-b', integrationBranch, integrationWorktreePath, baseRef],
    { stdio: 'pipe' },
  )

  for (const item of mergedBranches) {
    try {
      execFileSync(
        'git',
        ['-C', integrationWorktreePath, 'merge', '--no-ff', '--no-edit', item.branch],
        { stdio: 'pipe' },
      )
      item.mergeSha = execFileSync(
        'git',
        ['-C', integrationWorktreePath, 'rev-parse', '--short', 'HEAD'],
        { encoding: 'utf8' },
      ).trim()
    } catch {
      conflicts++
      execFileSync('git', ['-C', integrationWorktreePath, 'merge', '--abort'], { stdio: 'pipe' })
    }
  }

  const cleanup = () => {
    removeWorktrees(repoRoot, [
      integrationWorktreePath,
      ...workers.map((w) => w.worktreePath),
    ])
    for (const branch of createdBranches) {
      try {
        execFileSync('git', ['-C', repoRoot, 'branch', '-D', branch], { stdio: 'pipe' })
      } catch {
        // Ignore if already deleted
      }
    }
    rmSync(tempBase, { recursive: true, force: true })
  }

  return {
    integrationBranch,
    integrationWorktreePath,
    mergedBranches,
    conflicts,
    cleanup,
  }
}

function runGate(label, cmd, args, cwd) {
  const startMs = performance.now()
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return {
      label,
      passed: true,
      durationMs: Math.round(performance.now() - startMs),
      summary: out.trim().split('\n').slice(-6).join('\n'),
    }
  } catch (err) {
    return {
      label,
      passed: false,
      durationMs: Math.round(performance.now() - startMs),
      summary: String(err.stderr || err.stdout || err.message).trim().slice(-600),
    }
  }
}

function resolveDefaultModels() {
  const agents = JSON.parse(
    execFileSync('opencode', ['debug', 'agents', '--standalone'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }),
  )
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const formatModelId = (agentId) => {
    const model = agentsById.get(agentId)?.model
    return model ? `${model.providerID ?? model.provider}/${model.modelID ?? model.id}` : undefined
  }
  return {
    orchestrator: process.env.OPENCODE_ORCHESTRATOR_MODEL || formatModelId('orchestrator'),
    worker: process.env.OPENCODE_WORKER_MODEL || formatModelId('plc-coder'),
  }
}

function allGatesPassed(verification) {
  return Boolean(
    verification.contractTest?.passed &&
      verification.plcTest?.passed &&
      verification.oipValidate?.passed &&
      verification.e2eModbus?.passed,
  )
}

function renderProofMarkdown(proof) {
  const allAgents = [proof.orchestrator, ...proof.workers]
  if (proof.repairPass) {
    allAgents.push({ ...proof.repairPass, agent: `${proof.repairPass.agent} (repair)` })
  }

  const rows = allAgents.map((entry) => {
    const skills = entry.skillsLoaded.length > 0 ? entry.skillsLoaded.join(', ') : '(coordinator)'
    const worktree = entry.worktreePath ? `\`${entry.worktreePath}\`` : 'base/integration worktree'
    const tools = Object.entries(entry.toolsUsed ?? {})
      .map(([k, v]) => `${k}:${v}`)
      .join(', ') || 'none'
    return `| \`${entry.agent}\` | \`${entry.model}\` | ${skills} | ${tools} | ${worktree} | ${(entry.durationMs / 1000).toFixed(1)}s | ${entry.tokens.input} in / ${entry.tokens.reasoning} think / ${entry.tokens.output} out | \$${entry.costUsd.toFixed(5)} |`
  })

  const mergeRows = proof.merge.mergedBranches.map(
    (b) => `| \`${b.worker}\` | \`${b.branch}\` | \`${b.commitSha}\` | \`${b.mergeSha}\` | ${(b.filesChanged ?? []).map((f) => `\`${f}\``).join(', ') || '(none)'} |`,
  )

  return [
    '# OpenCode Parallel `git worktree` Orchestration Proof',
    '',
    `- **Run ID:** \`${proof.runId}\``,
    `- **Mode:** \`${proof.mode}\``,
    `- **Captured At:** \`${proof.capturedAt}\``,
    `- **Process Spec:** \`${proof.specPath}\``,
    `- **Canonical I/O Contract:** \`openplc/io-contract.json\``,
    `- **Tiered Models:** Orchestrator \`${proof.orchestrator.model}\` vs. 3 parallel workers \`${proof.workers[0].model}\``,
    `- **Parallel Window Overlap:** \`${proof.parallelOverlapMs} ms\` (all 3 workers active concurrently)`,
    `- **Integration Branch:** \`${proof.merge.integrationBranch}\` (\`${proof.merge.conflicts}\` merge conflicts)`,
    `- **Post-Merge Repair Passes:** \`${proof.repairAttempts ?? 0}\``,
    '',
    '## Tiered Model, Skill Scoping, Tool Calls & Cost Breakdown',
    '',
    '| Agent | Model | Skills Loaded | Tools Used | Worktree | Wall Time | Tokens | Cost (USD) |',
    '| :--- | :--- | :--- | :--- | :--- | ---: | :--- | ---: |',
    ...rows,
    '',
    '## Isolated Worktree Branches Merged Cleanly',
    '',
    '| Worker | Worktree Branch | Worker Commit | Merge Commit | Files Changed |',
    '| :--- | :--- | :--- | :--- | :--- |',
    ...mergeRows,
    '',
    '## Post-Merge Verification Gates (Executed on Merged Integration Worktree)',
    '',
    ...(proof.verification.contractTest
      ? [`- **I/O Contract Conformance (\`npm run test:contract\`):** ${proof.verification.contractTest.passed ? 'PASS' : 'FAIL'} (${(proof.verification.contractTest.durationMs / 1000).toFixed(1)}s)`]
      : []),
    `- **STruC++ PLC Unit Tests (\`npm run plc:test\`):** ${proof.verification.plcTest.passed ? 'PASS' : 'FAIL'} (${(proof.verification.plcTest.durationMs / 1000).toFixed(1)}s)`,
    `- **OIP Strict Validators (\`npm run oip:validate\`):** ${proof.verification.oipValidate.passed ? 'PASS' : 'FAIL'} (${(proof.verification.oipValidate.durationMs / 1000).toFixed(1)}s)`,
    `- **Live OpenPLC v4 <-> OIP Modbus TCP E2E (\`npm run test:e2e\`):** ${proof.verification.e2eModbus.passed ? 'PASS' : 'FAIL'} (${(proof.verification.e2eModbus.durationMs / 1000).toFixed(1)}s)`,
    '',
  ].join('\n')
}

function buildGreenfieldWorkerPrompt({ workerSpec, orchestratorBrief, repoRoot }) {
  const linkHint = `Local toolchains live at "${repoRoot}/.tools" and "${repoRoot}/Open-Industry-Project". If needed to run local validators inside your worktree, symlink them first (they are gitignored).`

  if (workerSpec.agent === 'plc-coder') {
    return [
      `Orchestrator dispatch brief:\n${orchestratorBrief}`,
      '',
      `1. Call the skill tool to load "openplc-st" and also read ".opencode/skills/openplc-st/strucpp-modbus-reference.md".`,
      `2. Read openplc/io-contract.json, docs/cell-process-spec.md, GLOSSARY.md, and scripts/io-contract.mjs.`,
      `3. Author from scratch:`,
      `   - openplc/conveyor_cell.st (FUNCTION_BLOCK ConveyorCellController with exact VAR_INPUT/VAR_OUTPUT names from openplc/io-contract.json and VAR CONSTANT matching parameters: BATCH_TARGET:=5, DWELL_TIME:=T#2s, JAM_THRESHOLD_TIME:=T#4s, SPAWN_PULSE_TIME:=T#500ms, SPAWN_COOLDOWN_TIME:=T#5s + PROGRAM ConveyorCellMain with located AT variables in their own VAR block + CONFIGURATION Config0 with INTERVAL := T#20ms task)`,
      `   - openplc/conveyor_cell_modbus_master.json (derive directly from openplc/io-contract.json via scripts/io-contract.mjs deriveModbusMasterConfig)`,
      `   - scenes/conveyor-cell/plc/program.st (byte-identical copy of openplc/conveyor_cell.st)`,
      `4. Self-heal (max 2 attempts): ${linkHint} Compile openplc/conveyor_cell.st with ".tools/strucpp/strucpp/strucpp openplc/conveyor_cell.st --debug -o /tmp/check_cell.cpp" and fix any errors.`,
      `5. Do NOT touch any files outside your owned scope. Reply with one concise summary sentence.`,
    ].join('\n')
  }

  if (workerSpec.agent === 'oip-builder') {
    return [
      `Orchestrator dispatch brief:\n${orchestratorBrief}`,
      '',
      `1. Call the skill tool to load "oip-scene".`,
      `2. Read openplc/io-contract.json and scenes/conveyor-cell/project.json. Do NOT read or grep inside Open-Industry-Project/ source files.`,
      `3. ${linkHint} Write scenes/conveyor-cell/scene.json (OIP format version 4) with the 9 parts matching every sceneRole in openplc/io-contract.json:`,
      `   - belt_1: packageId "oip.belt-conveyor", position [0.085,0.8,0], rotationY 0, params { fpmUnits:false, segments:[[5,0]], width:0.8, standHeight:0.8, speed:0.5, runTag:"%QX0.0" }`,
      `   - spawner_1: packageId "oip.box-spawner", position [0.35,1.25,0], rotationY 0, params { boxesPerMinute:12, length:0.4, keepSpacing:true, runTag:"%QX0.1", conveyorId:"belt_1", release:"enable" }`,
      `   - photoeye_1: packageId "oip.diffuse-sensor", position [2,0.78,0.457], rotationY 3.141593, params { tag:"%IX0.4", maxRange:0.84 }`,
      `   - start_pb: packageId "oip.push-button", parent "belt_1", position [0.5,0.8,-0.43], rotationY 3.141593, params { text:"START", buttonColor:"#16a34a", lampSource:"tag", tag:"%IX0.0", lampTag:"%QX0.2" }`,
      `   - stop_pb: packageId "oip.push-button", parent "belt_1", position [0.9,0.8,-0.43], rotationY 3.141593, params { buttonColor:"#d97706", lampSource:"tag", tag:"%IX0.1", lampTag:"%QX0.3" }`,
      `   - estop_pb: packageId "oip.push-button", parent "belt_1", position [1.3,0.8,-0.43], rotationY 3.141593, params { emergencyStop:true, text:"E-STOP", buttonColor:"#dc2626", momentary:false, lampSource:"tag", tag:"%IX0.2", lampTag:"%QX0.4" }`,
      `   - reset_pb: packageId "oip.push-button", parent "belt_1", position [1.7,0.8,-0.43], rotationY 3.141593, params { text:"RESET", buttonColor:"#2563eb", tag:"%IX0.3" }`,
      `   - despawner_1: packageId "oip.despawner", position [6.17,0,0], rotationY 0, params { length:1.2, width:1.2, countTag:"" }`,
      `   - batch_indicator: packageId "oip.stack-light", position [2.1,0,-0.6], rotationY 0, params { tag:"%QW0" }`,
      `4. Self-heal (max 2 attempts): Run validate-project --strict, check-wiring --strict, and check-layout --strict against "$PWD/scenes/conveyor-cell" via "npm --prefix Open-Industry-Project run ..." and fix any errors using edit-part or direct edits.`,
      `5. Do NOT modify scenes/conveyor-cell/plc/program.st or any files outside scenes/conveyor-cell/scene.json. Reply with one concise summary sentence.`,
    ].join('\n')
  }

  return [
    `Orchestrator dispatch brief:\n${orchestratorBrief}`,
    '',
    `1. Call the skill tool to load "plc-oip-verify" and also read ".opencode/skills/plc-oip-verify/verification-seams.md".`,
    `2. Read openplc/io-contract.json, docs/cell-process-spec.md, and GLOSSARY.md.`,
    `3. Author tests/conveyor_cell.test.st from scratch testing FUNCTION_BLOCK ConveyorCellController across all 7 behaviors: Start/Stop latch, E-Stop + no auto-restart on release, Photo-Eye rising edge + 2s Inspection Dwell, 5-box Batch auto-halt + Reset-when-stopped, Reset ignored while running, Spawner_Enable 500ms pulse + 5s cooldown + dwell inhibit, and 4s continuous Photo-Eye Jam Fault.`,
    `4. Self-heal (max 2 attempts): ${linkHint} Verify syntax follows STruC++ test rules strictly: single-quoted TEST '...' titles, top-level ADVANCE_TIME(<ns>) only (never inside FOR/IF), SETUP instantiating "cell : ConveyorCellController".`,
    `5. Do NOT touch any files outside tests/conveyor_cell.test.st. Reply with one concise summary sentence.`,
  ].join('\n')
}

export async function runOrchestration({
  specPath = 'docs/cell-process-spec.md',
  orchestratorModel,
  workerModel,
  usePreflight = false,
  fromScratch = false,
} = {}) {
  const defaults = resolveDefaultModels()
  let resolvedOrchestratorModel = orchestratorModel ?? defaults.orchestrator
  let resolvedWorkerModel = workerModel ?? defaults.worker
  let fallbackUsed = false

  let machine = createInitialState({ maxPostMergeRepairs: 1 })
  machine = stepMachine(machine, { type: 'START_PREFLIGHT' })

  if (usePreflight) {
    const probed = await probeModelPair()
    if (!probed.ok) {
      machine = stepMachine(machine, { type: 'PREFLIGHT_FAILED', reason: 'No live-callable model pair available.' })
      throw new Error(`Model preflight failed: ${JSON.stringify(probed.attempts)}`)
    }
    resolvedOrchestratorModel = orchestratorModel ?? probed.orchestratorModel
    resolvedWorkerModel = workerModel ?? probed.workerModel
    fallbackUsed = probed.fallbackUsed
  }

  machine = stepMachine(machine, {
    type: 'PREFLIGHT_RESOLVED',
    orchestratorModel: resolvedOrchestratorModel,
    workerModel: resolvedWorkerModel,
    fallbackUsed,
  })
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const specText = readFileSync(join(REPO_ROOT, specPath), 'utf8')

  const greenfieldBase = fromScratch
    ? prepareGreenfieldBase({ repoRoot: REPO_ROOT, runId })
    : null
  const workCwd = greenfieldBase ? greenfieldBase.baseWorktreePath : REPO_ROOT

  let orchestrator
  let workerResults
  let merge
  let verification
  let repairPass = null
  const preStage2Worktrees = listWorktreePaths(REPO_ROOT)

  const cleanupNewWorktrees = () => {
    const current = listWorktreePaths(REPO_ROOT)
    const created = [...current].filter(
      (p) => !preStage2Worktrees.has(p) && (!greenfieldBase || p !== greenfieldBase.baseWorktreePath),
    )
    if (created.length > 0) removeWorktrees(REPO_ROOT, created)
  }

  try {
    console.log(
      `[orchestrate:${runId}] Stage 1: Orchestrator (${resolvedOrchestratorModel}) ${fromScratch ? 'synthesizing canonical I/O Contract from scratch' : 'reviewing spec & I/O Contract'}...`,
    )
    try {
      const stage1Prompt = fromScratch
        ? [
            `Read ONLY "scripts/io-contract.mjs" to check the required JSON schema (including sceneRole). Do NOT read, glob, or grep any other files.`,
            `Use the write tool to create "${join(workCwd, 'openplc', 'io-contract.json')}" from scratch with valid JSON for all 11 signals (Start_PB %IX0.0 start_pb.tag, Stop_PB %IX0.1 stop_pb.tag, EStop %IX0.2 estop_pb.tag, Reset_Count_PB %IX0.3 reset_pb.tag, PhotoEye %IX0.4 photoeye_1.tag, Conveyor_Run %QX0.0 belt_1.runTag, Spawner_Enable %QX0.1 spawner_1.runTag, Run_Light %QX0.2 start_pb.lampTag, Dwell_Light %QX0.3 stop_pb.lampTag, Fault_Light %QX0.4 estop_pb.lampTag, Box_Count %QW0 batch_indicator.tag), parameters (scanIntervalMs:20, inspectionDwellMs:2000, batchTarget:5, spawnPulseMs:500, spawnCooldownMs:5000, jamTimeoutMs:4000), and Modbus settings (host.docker.internal:5020, slaveId:1, cycleTimeMs:50).`,
            `Then immediately reply with a concise 3-bullet dispatch brief (one bullet each for plc-coder, oip-builder, and test-engineer).`,
            '',
            specText,
          ].join('\n')
        : [
            `Read ${specPath} and openplc/io-contract.json.`,
            `Confirm that all signals in openplc/io-contract.json cover the plain-English specification below and emit a 3-bullet dispatch brief (one bullet each for plc-coder, oip-builder, and test-engineer). Do not edit files.`,
            '',
            specText,
          ].join('\n')

      orchestrator = await runOpenCodeAsync({
        agent: 'orchestrator',
        model: resolvedOrchestratorModel,
        prompt: stage1Prompt,
        cwd: workCwd,
        timeoutMs: 360000,
      })
    } catch (err) {
      machine = stepMachine(machine, { type: 'ORCHESTRATOR_FAILED', reason: err.message })
      throw err
    }

    if (greenfieldBase) {
      const synthesizedContractPath = join(workCwd, 'openplc', 'io-contract.json')
      if (!existsSync(synthesizedContractPath)) {
        throw new Error(
          `Orchestrator did not write ${synthesizedContractPath} (tools=${JSON.stringify(orchestrator.toolsUsed)}): ${orchestrator.finalText.slice(0, 300)}`,
        )
      }
      execFileSync('git', ['-C', workCwd, 'add', 'openplc/io-contract.json'], { stdio: 'pipe' })
      execFileSync(
        'git',
        ['-C', workCwd, 'commit', '--no-verify', '-m', 'feat: orchestrator synthesized canonical I/O Contract'],
        { stdio: 'pipe' },
      )
    }

    const contract = JSON.parse(readFileSync(join(workCwd, 'openplc', 'io-contract.json'), 'utf8'))
    machine = stepMachine(machine, { type: 'ORCHESTRATOR_DONE' })

    console.log(
      `[orchestrate:${runId}] Stage 2: Dispatching 3 parallel workers (${resolvedWorkerModel}) in isolated git worktrees...`,
    )
    const workerSettled = await Promise.allSettled(
      WORKER_SPECS.map((workerSpec) =>
        runOpenCodeAsync({
          agent: workerSpec.agent,
          model: resolvedWorkerModel,
          worktreeName: `${runId}-${workerSpec.agent}`,
          cwd: workCwd,
          timeoutMs: fromScratch ? 360000 : 240000,
          prompt: fromScratch
            ? buildGreenfieldWorkerPrompt({
                workerSpec,
                orchestratorBrief: orchestrator.finalText,
                repoRoot: REPO_ROOT,
              })
            : [
                `Orchestrator dispatch brief:\n${orchestrator.finalText}`,
                '',
                `Call the skill tool to load "${workerSpec.expectedSkill}".`,
                `Verify your owned files (${workerSpec.ownedFiles.join(', ')}) against openplc/io-contract.json and write "worktree-manifest-${workerSpec.agent}.json" at the repo root with {"agent":"${workerSpec.agent}","skill":"${workerSpec.expectedSkill}","signalsVerified":${contract.signals.length},"ownedFiles":${JSON.stringify(workerSpec.ownedFiles)},"status":"verified"}.`,
                `Reply with one concise sentence confirming the skill loaded and manifest written.`,
              ].join('\n'),
        }).then((res) => ({ ...res, expectedSkill: workerSpec.expectedSkill })),
      ),
    )

    const failedIdx = workerSettled.findIndex((r) => r.status === 'rejected')
    if (failedIdx >= 0) {
      cleanupNewWorktrees()
      machine = stepMachine(machine, {
        type: 'WORKER_API_ABORT',
        worker: WORKER_SPECS[failedIdx].agent,
        reason: workerSettled[failedIdx].reason?.message,
      })
      throw workerSettled[failedIdx].reason
    }

    workerResults = workerSettled.map((r) => r.value)
    for (const w of workerResults) {
      if (!w.worktreePath) {
        cleanupNewWorktrees()
        machine = stepMachine(machine, {
          type: 'WORKER_API_ABORT',
          worker: w.agent,
          reason: `Worker "${w.agent}" did not report an isolated git worktree path`,
        })
        throw new Error(`Worker "${w.agent}" did not report an isolated git worktree path`)
      }
      machine = stepMachine(machine, { type: 'WORKER_SUCCEED', worker: w.agent })
    }

    console.log(`[orchestrate:${runId}] Stage 3: Merging 3 worker worktree branches into integration branch...`)
    const baseRef = greenfieldBase ? greenfieldBase.baseBranch : 'HEAD'
    try {
      merge = mergeWorkerBranches({
        repoRoot: REPO_ROOT,
        runId,
        baseRef,
        workers: workerResults.map((w) => ({
          name: w.agent,
          worktreePath: w.worktreePath,
          ownedFiles: fromScratch
            ? WORKER_SPECS.find((s) => s.agent === w.agent)?.ownedFiles
            : undefined,
        })),
      })
    } catch (err) {
      cleanupNewWorktrees()
      machine = stepMachine(machine, { type: 'MERGE_CONFLICT', conflicts: 1 })
      throw err
    }

    if (merge.conflicts > 0) {
      machine = stepMachine(machine, { type: 'MERGE_CONFLICT', conflicts: merge.conflicts })
      throw new Error(`Merge produced ${merge.conflicts} conflict(s)`)
    }
    machine = stepMachine(machine, { type: 'MERGE_CLEAN' })

    linkLocalToolchains(REPO_ROOT, merge.integrationWorktreePath)

    const runAllGates = () => {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const contractTest = runGate('test:contract', npmCmd, ['run', 'test:contract'], merge.integrationWorktreePath)
      const plcTest = runGate('plc:test', npmCmd, ['run', 'plc:test'], merge.integrationWorktreePath)
      const oipValidate = runGate('oip:validate', npmCmd, ['run', 'oip:validate'], merge.integrationWorktreePath)
      const e2eModbus =
        contractTest.passed && plcTest.passed && oipValidate.passed
          ? runGate('test:e2e', npmCmd, ['run', 'test:e2e'], merge.integrationWorktreePath)
          : { label: 'test:e2e', passed: false, durationMs: 0, summary: 'Skipped until fast gates pass' }
      return { contractTest, plcTest, oipValidate, e2eModbus }
    }

    console.log(`[orchestrate:${runId}] Stage 4: Running verification gates on merged integration worktree...`)
    verification = runAllGates()

    while (!allGatesPassed(verification)) {
      machine = stepMachine(machine, {
        type: 'GATE_FAIL_REPAIR',
        gates: {
          plcTest: verification.plcTest.passed ? 'pass' : 'fail',
          oipValidate: verification.oipValidate.passed ? 'pass' : 'fail',
          e2eModbus: verification.e2eModbus.passed ? 'pass' : 'fail',
        },
      })
      if (machine.phase === 'failed') {
        throw new Error(
          `Verification gate failed after repair budget exhausted: contract=${verification.contractTest.passed}, plc=${verification.plcTest.passed}, oip=${verification.oipValidate.passed}, e2e=${verification.e2eModbus.passed}`,
        )
      }

      const failureSummary = [
        `test:contract (${verification.contractTest.passed ? 'PASS' : 'FAIL'}):\n${verification.contractTest.summary}`,
        `plc:test (${verification.plcTest.passed ? 'PASS' : 'FAIL'}):\n${verification.plcTest.summary}`,
        `oip:validate (${verification.oipValidate.passed ? 'PASS' : 'FAIL'}):\n${verification.oipValidate.summary}`,
        `test:e2e (${verification.e2eModbus.passed ? 'PASS' : 'FAIL'}):\n${verification.e2eModbus.summary}`,
      ].join('\n\n')

      console.log(
        `[orchestrate:${runId}] Stage 4 Repair Pass ${machine.repairAttempts}/${machine.maxPostMergeRepairs}: Orchestrator patching integration worktree...\n${failureSummary}`,
      )

      repairPass = await runOpenCodeAsync({
        agent: 'orchestrator',
        model: resolvedOrchestratorModel,
        cwd: merge.integrationWorktreePath,
        timeoutMs: 420000,
        prompt: [
          `Post-merge verification failed in the integration worktree. Fix ONLY the failing files reported below so test:contract, plc:test, oip:validate, and test:e2e all pass.`,
          `Do NOT browse Open-Industry-Project/ or load skills; read only the specific failing file(s) and apply minimal targeted fixes.`,
          `Keep openplc/conveyor_cell.st and scenes/conveyor-cell/plc/program.st byte-identical.`,
          `Run "npm run test:contract && npm run plc:test && npm run oip:validate" to confirm before finishing.`,
          '',
          failureSummary,
        ].join('\n'),
      })
      machine = stepMachine(machine, { type: 'REPAIR_PATCH_APPLIED' })

      verification = runAllGates()
    }

    machine = stepMachine(machine, { type: 'GATES_ALL_PASS' })
  } finally {
    if (merge) merge.cleanup()
    cleanupNewWorktrees()
    if (greenfieldBase) greenfieldBase.cleanup()
  }

  const latestStart = Math.max(...workerResults.map((w) => Date.parse(w.startedAt)))
  const earliestEnd = Math.min(...workerResults.map((w) => Date.parse(w.finishedAt)))
  const parallelOverlapMs = Math.max(0, earliestEnd - latestStart)

  const proof = {
    runId,
    mode: fromScratch ? 'from-scratch' : 'verify',
    capturedAt: new Date().toISOString(),
    specPath,
    parallelOverlapMs,
    repairAttempts: machine.repairAttempts,
    orchestrator,
    workers: workerResults,
    ...(repairPass ? { repairPass } : {}),
    merge: {
      integrationBranch: merge.integrationBranch,
      conflicts: merge.conflicts,
      mergedBranches: merge.mergedBranches,
    },
    verification,
  }

  writeFileSync(
    join(REPO_ROOT, 'docs', 'orchestration-proof.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(REPO_ROOT, 'docs', 'orchestration-proof.md'),
    renderProofMarkdown(proof),
    'utf8',
  )

  console.log(`[orchestrate:${runId}] Complete! Proof written to docs/orchestration-proof.{json,md}`)
  return proof
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const getFlag = (name) => {
    const idx = args.indexOf(name)
    return idx >= 0 ? args[idx + 1] : undefined
  }
  runOrchestration({
    specPath: getFlag('--spec') ?? 'docs/cell-process-spec.md',
    orchestratorModel: getFlag('--orchestrator-model'),
    workerModel: getFlag('--worker-model'),
    usePreflight: args.includes('--preflight'),
    fromScratch: args.includes('--from-scratch'),
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
