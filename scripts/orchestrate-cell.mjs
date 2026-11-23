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
        reject(new Error(abortedReason))
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

export function mergeWorkerBranches({ repoRoot, runId, workers }) {
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
    execFileSync('git', ['-C', worker.worktreePath, 'add', '-A'], { stdio: 'pipe' })
    const status = execFileSync('git', ['-C', worker.worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim()
    const commitArgs = ['-C', worker.worktreePath, 'commit', '-m', `chore: worker ${worker.name} output`]
    if (!status) commitArgs.push('--allow-empty')
    execFileSync('git', commitArgs, { stdio: 'pipe' })
    const sha = execFileSync('git', ['-C', worker.worktreePath, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    mergedBranches.push({ worker: worker.name, branch, commitSha: sha, worktreePath: worker.worktreePath })
  }

  execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'add', '-b', integrationBranch, integrationWorktreePath, 'HEAD'],
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

function renderProofMarkdown(proof) {
  const rows = [proof.orchestrator, ...proof.workers].map((entry) => {
    const skills = entry.skillsLoaded.length > 0 ? entry.skillsLoaded.join(', ') : '(coordinator)'
    const worktree = entry.worktreePath ? `\`${entry.worktreePath}\`` : 'repo root'
    return `| \`${entry.agent}\` | \`${entry.model}\` | ${skills} | ${worktree} | ${(entry.durationMs / 1000).toFixed(1)}s | ${entry.tokens.input} in / ${entry.tokens.reasoning} think / ${entry.tokens.output} out | \$${entry.costUsd.toFixed(5)} |`
  })

  const mergeRows = proof.merge.mergedBranches.map(
    (b) => `| \`${b.worker}\` | \`${b.branch}\` | \`${b.commitSha}\` | \`${b.mergeSha}\` |`,
  )

  return [
    '# OpenCode Parallel `git worktree` Orchestration Proof',
    '',
    `- **Run ID:** \`${proof.runId}\``,
    `- **Captured At:** \`${proof.capturedAt}\``,
    `- **Process Spec:** \`${proof.specPath}\``,
    `- **Canonical I/O Contract:** \`openplc/io-contract.json\``,
    `- **Tiered Models:** Orchestrator \`${proof.orchestrator.model}\` vs. 3 parallel workers \`${proof.workers[0].model}\``,
    `- **Parallel Window Overlap:** \`${proof.parallelOverlapMs} ms\` (all 3 workers active concurrently)`,
    `- **Integration Branch:** \`${proof.merge.integrationBranch}\` (\`${proof.merge.conflicts}\` merge conflicts)`,
    '',
    '## Tiered Model, Skill Scoping & Cost Breakdown',
    '',
    '| Agent | Model | Skills Loaded | Worktree | Wall Time | Tokens | Cost (USD) |',
    '| :--- | :--- | :--- | :--- | ---: | :--- | ---: |',
    ...rows,
    '',
    '## Isolated Worktree Branches Merged Cleanly',
    '',
    '| Worker | Worktree Branch | Worker Commit | Merge Commit |',
    '| :--- | :--- | :--- | :--- |',
    ...mergeRows,
    '',
    '## Post-Merge Verification Gates (Executed on Merged Integration Worktree)',
    '',
    `- **STruC++ PLC Unit Tests (\`npm run plc:test\`):** ${proof.verification.plcTest.passed ? 'PASS' : 'FAIL'} (${(proof.verification.plcTest.durationMs / 1000).toFixed(1)}s)`,
    `- **OIP Strict Validators (\`npm run oip:validate\`):** ${proof.verification.oipValidate.passed ? 'PASS' : 'FAIL'} (${(proof.verification.oipValidate.durationMs / 1000).toFixed(1)}s)`,
    `- **Live OpenPLC v4 <-> OIP Modbus TCP E2E (\`npm run test:e2e\`):** ${proof.verification.e2eModbus.passed ? 'PASS' : 'FAIL'} (${(proof.verification.e2eModbus.durationMs / 1000).toFixed(1)}s)`,
    '',
  ].join('\n')
}

export async function runOrchestration({
  specPath = 'docs/cell-process-spec.md',
  orchestratorModel,
  workerModel,
  usePreflight = false,
} = {}) {
  const defaults = resolveDefaultModels()
  let resolvedOrchestratorModel = orchestratorModel ?? defaults.orchestrator
  let resolvedWorkerModel = workerModel ?? defaults.worker
  let fallbackUsed = false

  let machine = createInitialState()
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
  const contract = JSON.parse(readFileSync(join(REPO_ROOT, 'openplc', 'io-contract.json'), 'utf8'))

  console.log(`[orchestrate:${runId}] Stage 1: Orchestrator (${resolvedOrchestratorModel}) reviewing spec & I/O Contract...`)
  let orchestrator
  try {
    orchestrator = await runOpenCodeAsync({
      agent: 'orchestrator',
      model: resolvedOrchestratorModel,
      prompt: [
        `Read ${specPath} and openplc/io-contract.json.`,
        `Confirm that all ${contract.signals.length} signals in openplc/io-contract.json cover the plain-English specification below and emit a 3-bullet dispatch brief (one bullet each for plc-coder, oip-builder, and test-engineer). Do not edit files.`,
        '',
        specText,
      ].join('\n'),
    })
  } catch (err) {
    machine = stepMachine(machine, { type: 'ORCHESTRATOR_FAILED', reason: err.message })
    throw err
  }
  machine = stepMachine(machine, { type: 'ORCHESTRATOR_DONE' })

  const preStage2Worktrees = listWorktreePaths(REPO_ROOT)
  const cleanupNewWorktrees = () => {
    const current = listWorktreePaths(REPO_ROOT)
    const created = [...current].filter((p) => !preStage2Worktrees.has(p))
    if (created.length > 0) removeWorktrees(REPO_ROOT, created)
  }

  console.log(`[orchestrate:${runId}] Stage 2: Dispatching 3 parallel workers (${resolvedWorkerModel}) in isolated git worktrees...`)
  const workerSettled = await Promise.allSettled(
    WORKER_SPECS.map((workerSpec) =>
      runOpenCodeAsync({
        agent: workerSpec.agent,
        model: resolvedWorkerModel,
        worktreeName: `${runId}-${workerSpec.agent}`,
        prompt: [
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

  const workerResults = workerSettled.map((r) => r.value)
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
  let merge
  try {
    merge = mergeWorkerBranches({
      repoRoot: REPO_ROOT,
      runId,
      workers: workerResults.map((w) => ({ name: w.agent, worktreePath: w.worktreePath })),
    })
  } catch (err) {
    cleanupNewWorktrees()
    machine = stepMachine(machine, { type: 'MERGE_CONFLICT', conflicts: 1 })
    throw err
  }

  let verification
  try {
    if (merge.conflicts > 0) {
      machine = stepMachine(machine, { type: 'MERGE_CONFLICT', conflicts: merge.conflicts })
      throw new Error(`Merge produced ${merge.conflicts} conflict(s)`)
    }
    machine = stepMachine(machine, { type: 'MERGE_CLEAN' })

    // Link gitignored local toolchains into the merged integration worktree so all gates run against merged code
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
    for (const dir of ['.tools', 'Open-Industry-Project']) {
      const src = join(REPO_ROOT, dir)
      const dst = join(merge.integrationWorktreePath, dir)
      if (existsSync(src) && !existsSync(dst)) {
        symlinkSync(src, dst, symlinkType)
      }
    }

    console.log(`[orchestrate:${runId}] Stage 4: Running verification gates on merged integration worktree...`)
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const plcTest = runGate('plc:test', npmCmd, ['run', 'plc:test'], merge.integrationWorktreePath)
    const oipValidate = runGate('oip:validate', npmCmd, ['run', 'oip:validate'], merge.integrationWorktreePath)
    const e2eModbus = runGate('test:e2e', npmCmd, ['run', 'test:e2e'], merge.integrationWorktreePath)

    verification = { plcTest, oipValidate, e2eModbus }
    if (!plcTest.passed || !oipValidate.passed || !e2eModbus.passed) {
      machine = stepMachine(machine, {
        type: 'GATE_FAIL_REPAIR',
        gates: {
          plcTest: plcTest.passed ? 'pass' : 'fail',
          oipValidate: oipValidate.passed ? 'pass' : 'fail',
          e2eModbus: e2eModbus.passed ? 'pass' : 'fail',
        },
      })
      throw new Error(
        `Verification gate failed: plc=${plcTest.passed}, oip=${oipValidate.passed}, e2e=${e2eModbus.passed}`,
      )
    }
    machine = stepMachine(machine, { type: 'GATES_ALL_PASS' })
  } finally {
    merge.cleanup()
    cleanupNewWorktrees()
  }

  const latestStart = Math.max(...workerResults.map((w) => Date.parse(w.startedAt)))
  const earliestEnd = Math.min(...workerResults.map((w) => Date.parse(w.finishedAt)))
  const parallelOverlapMs = Math.max(0, earliestEnd - latestStart)

  const proof = {
    runId,
    capturedAt: new Date().toISOString(),
    specPath,
    parallelOverlapMs,
    orchestrator,
    workers: workerResults,
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
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
