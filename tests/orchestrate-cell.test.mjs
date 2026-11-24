import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildGreenfieldWorkerPrompt,
  buildStage1Prompt,
  GREENFIELD_FILES,
  inspectNdjsonRetryLine,
  mergeWorkerBranches,
  parseOpenCodeNdjson,
  prepareGreenfieldBase,
  runOrchestration,
  WORKER_SPECS,
} from '../scripts/orchestrate-cell.mjs'
import {
  createGates,
  createInitialState,
  transition,
} from '../scripts/orchestration-machine.mjs'
import { EventEmitter } from 'node:events'
import { probeModelPair, probeSingleModel } from '../scripts/opencode-probe.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Parallel git worktree orchestration pipeline', () => {
  it('parses OpenCode NDJSON stream for worktree path, skills loaded, tokens, and cost', () => {
    const sample = [
      'worktree /tmp/opencode/worktree/abc/calm-river',
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_123',
        part: {
          tool: 'skill',
          state: { status: 'completed', input: { id: 'openplc-st' } },
        },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_123',
        part: {
          cost: 0.0022,
          tokens: { input: 7000, output: 120, reasoning: 15, cache: { read: 0, write: 0 } },
        },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_123',
        part: { text: 'PLC artifacts verified.' },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_123',
        part: {
          cost: 0.0008,
          tokens: { input: 2000, output: 30, reasoning: 0, cache: { read: 5000, write: 0 } },
        },
      }),
    ].join('\n')

    const parsed = parseOpenCodeNdjson(sample)
    assert.equal(parsed.worktreePath, '/tmp/opencode/worktree/abc/calm-river')
    assert.equal(parsed.sessionId, 'ses_123')
    assert.deepEqual(parsed.skillsLoaded, ['openplc-st'])
    assert.equal(parsed.tokens.input, 9000)
    assert.equal(parsed.tokens.output, 150)
    assert.equal(parsed.tokens.reasoning, 15)
    assert.equal(parsed.tokens.cacheRead, 5000)
    assert.ok(Math.abs(parsed.costUsd - 0.003) < 1e-9)
    assert.equal(parsed.finalText, 'PLC artifacts verified.')
  })

  it('merges three non-overlapping git worktree branches cleanly into an integration branch', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orchestrate-merge-test-'))
    const repoDir = join(tempDir, 'repo')
    try {
      execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' })
      execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'])
      execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'])
      writeFileSync(join(repoDir, 'README.md'), '# test\n')
      execFileSync('git', ['-C', repoDir, 'add', '.'])
      execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'])

      const workers = ['plc-coder', 'oip-builder', 'test-engineer']
      const worktreeBranches = []
      for (const worker of workers) {
        const wtPath = join(tempDir, `wt-${worker}`)
        execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', wtPath, 'HEAD'], {
          stdio: 'pipe',
        })
        writeFileSync(join(wtPath, `${worker}.txt`), `output from ${worker}\n`)
        worktreeBranches.push({ name: worker, worktreePath: wtPath })
      }

      const result = mergeWorkerBranches({
        repoRoot: repoDir,
        runId: 'test-run',
        workers: worktreeBranches,
      })

      assert.equal(result.conflicts, 0)
      assert.equal(result.mergedBranches.length, 3)
      for (const worker of workers) {
        const mergedFile = join(result.integrationWorktreePath, `${worker}.txt`)
        assert.equal(existsSync(mergedFile), true, `Expected ${worker}.txt in integration worktree`)
      }

      result.cleanup()
      assert.equal(existsSync(result.integrationWorktreePath), false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('has a captured orchestration proof demonstrating parallel worktrees, scoped skills, tiered models, and passing gates', () => {
    const proofJsonPath = join(REPO_ROOT, 'docs', 'orchestration-proof.json')
    const proofMdPath = join(REPO_ROOT, 'docs', 'orchestration-proof.md')
    assert.equal(existsSync(proofJsonPath), true, 'Missing docs/orchestration-proof.json')
    assert.equal(existsSync(proofMdPath), true, 'Missing docs/orchestration-proof.md')

    const proof = JSON.parse(readFileSync(proofJsonPath, 'utf8'))
    assert.equal(proof.orchestrator.agent, 'orchestrator')
    assert.equal(proof.workers.length, 3)

    // Verify tiered model separation
    for (const worker of proof.workers) {
      assert.notEqual(
        worker.model,
        proof.orchestrator.model,
        `Worker ${worker.agent} must use a distinct faster/lower-cost model than orchestrator`,
      )
      assert.ok(worker.worktreePath, `Worker ${worker.agent} must run in an isolated worktree`)
      assert.deepEqual(
        worker.skillsLoaded,
        [worker.expectedSkill],
        `Worker ${worker.agent} must load only its domain skill ${worker.expectedSkill}`,
      )
    }

    // Verify concurrent execution overlap across all 3 workers
    const latestStart = Math.max(...proof.workers.map((w) => Date.parse(w.startedAt)))
    const earliestEnd = Math.min(...proof.workers.map((w) => Date.parse(w.finishedAt)))
    assert.ok(
      latestStart < earliestEnd,
      'Expected all three workers to execute concurrently with overlapping wall-clock windows',
    )

    // Verify clean merge, real greenfield diffs, and passing gates
    assert.equal(proof.mode, 'from-scratch')
    assert.equal(proof.merge.conflicts, 0)
    assert.equal(proof.merge.mergedBranches.length, 3)
    for (const branch of proof.merge.mergedBranches) {
      assert.ok(
        Array.isArray(branch.filesChanged) && branch.filesChanged.length > 0,
        `Expected worker "${branch.worker}" to produce real changed files`,
      )
    }
    assert.equal(proof.verification.contractTest?.passed, true)
    assert.equal(proof.verification.plcTest.passed, true)
    assert.equal(proof.verification.oipValidate.passed, true)
    assert.equal(proof.verification.e2eModbus.passed, true)
  })

  it('enforces legal orchestration state transitions, bounded repairs, and zero leaked worktrees', () => {
    let state = createInitialState({ maxWorkerSelfHeals: 2, maxPostMergeRepairs: 1 })
    assert.deepEqual(state.gates, createGates('pending'))
    assert.deepEqual(state.gates, {
      contractTest: 'pending',
      plcTest: 'pending',
      oipValidate: 'pending',
      e2eModbus: 'pending',
    })
    state = transition(state, { type: 'START_PREFLIGHT' })
    state = transition(state, {
      type: 'PREFLIGHT_RESOLVED',
      orchestratorModel: 'google/gemini-4-neon',
      workerModel: 'google/gemini-3.8-flash',
      fallbackUsed: false,
    })
    assert.equal(state.phase, 'stage1_orchestrator')

    state = transition(state, { type: 'ORCHESTRATOR_DONE' })
    assert.equal(state.phase, 'stage2_workers')
    assert.equal(state.leakedWorktrees, 3)

    // Illegal early merge while workers are still running must be rejected
    state = transition(state, { type: 'WORKER_SUCCEED', worker: 'plc-coder' })
    const illegal = transition(state, { type: 'MERGE_CLEAN' })
    assert.equal(illegal.lastRejected, true)
    assert.equal(illegal.phase, 'stage2_workers')

    // Complete remaining workers and merge cleanly
    state = transition(state, { type: 'WORKER_SUCCEED', worker: 'oip-builder' })
    state = transition(state, { type: 'WORKER_SUCCEED', worker: 'test-engineer' })
    assert.equal(state.phase, 'stage3_merge')

    state = transition(state, { type: 'MERGE_CLEAN' })
    assert.equal(state.phase, 'stage4_verify')
    assert.equal(state.leakedWorktrees, 4)

    // First post-merge failure triggers repair pass with all 4 gate keys normalized
    state = transition(state, {
      type: 'GATE_FAIL_REPAIR',
      gates: { contractTest: 'fail', plcTest: 'pass', oipValidate: 'pass' },
    })
    assert.equal(state.phase, 'stage4_repair')
    assert.equal(state.repairAttempts, 1)
    assert.deepEqual(state.gates, {
      contractTest: 'fail',
      plcTest: 'pass',
      oipValidate: 'pass',
      e2eModbus: 'pending',
    })

    state = transition(state, { type: 'REPAIR_PATCH_APPLIED' })
    assert.equal(state.phase, 'stage4_verify')
    assert.deepEqual(state.gates, createGates('pending'))

    // Default GATE_FAIL_REPAIR uses all 4 gates and exhausts budget on second failure
    state = transition(state, { type: 'GATE_FAIL_REPAIR' })
    assert.equal(state.phase, 'failed')
    assert.equal(state.leakedWorktrees, 0)
    assert.deepEqual(state.gates, {
      contractTest: 'pass',
      plcTest: 'pass',
      oipValidate: 'fail',
      e2eModbus: 'pending',
    })

    // Happy-path done, worker API abort, and merge conflict all guarantee zero leaked worktrees
    let doneState = createInitialState()
    doneState = transition(doneState, { type: 'START_PREFLIGHT' })
    doneState = transition(doneState, {
      type: 'PREFLIGHT_RESOLVED',
      orchestratorModel: 'google/gemini-4-neon',
      workerModel: 'google/gemini-3.8-flash',
    })
    doneState = transition(doneState, { type: 'ORCHESTRATOR_DONE' })
    const aborted = transition(doneState, { type: 'WORKER_API_ABORT', worker: 'oip-builder' })
    assert.equal(aborted.phase, 'failed')
    assert.equal(aborted.leakedWorktrees, 0)

    doneState = transition(doneState, { type: 'WORKER_SUCCEED', worker: 'plc-coder' })
    doneState = transition(doneState, { type: 'WORKER_SUCCEED', worker: 'oip-builder' })
    doneState = transition(doneState, { type: 'WORKER_SUCCEED', worker: 'test-engineer' })
    const conflicted = transition(doneState, { type: 'MERGE_CONFLICT', conflicts: 1 })
    assert.equal(conflicted.phase, 'failed')
    assert.equal(conflicted.leakedWorktrees, 0)

    doneState = transition(doneState, { type: 'MERGE_CLEAN' })
    doneState = transition(doneState, { type: 'GATES_ALL_PASS' })
    assert.equal(doneState.phase, 'done')
    assert.equal(doneState.leakedWorktrees, 0)
    assert.deepEqual(doneState.gates, createGates('pass'))
  })

  it('aborts probeSingleModel on hard timeout with SIGTERM and handles split NDJSON chunks', async () => {
    let killedSignal = null
    const hangingSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.killed = false
      child.kill = (sig) => {
        killedSignal = sig
        child.killed = true
      }
      return child
    }

    const timedOut = await probeSingleModel('google/gemini-3.8-flash', {
      timeoutMs: 40,
      spawnFn: hangingSpawn,
    })
    assert.equal(timedOut.ok, false)
    assert.match(timedOut.reason, /Timed out after 40ms/)
    assert.equal(killedSignal, 'SIGTERM')

    // Verify chunk-split NDJSON retry event still triggers fail-fast abort
    let chunkChild
    const chunkSpawn = () => {
      chunkChild = new EventEmitter()
      chunkChild.stdout = new EventEmitter()
      chunkChild.stderr = new EventEmitter()
      chunkChild.killed = false
      chunkChild.kill = () => {
        chunkChild.killed = true
      }
      queueMicrotask(() => {
        const line = JSON.stringify({
          type: 'retry',
          attempt: 2,
          error: { status: 503, message: 'high demand' },
        })
        chunkChild.stdout.emit('data', Buffer.from(line.slice(0, 20)))
        chunkChild.stdout.emit('data', Buffer.from(`${line.slice(20)}\n`))
      })
      return chunkChild
    }

    const aborted = await probeSingleModel('google/gemini-3.8-flash', {
      timeoutMs: 2000,
      spawnFn: chunkSpawn,
    })
    assert.equal(aborted.ok, false)
    assert.match(aborted.reason, /503/)
  })

  it('probes prioritized model candidates with fallback and fails cleanly when none are live', async () => {
    const responses = {
      'google/gemini-4-neon': { ok: true, durationMs: 420 },
      'google/gemini-3.8-flash': { ok: false, reason: 'HTTP 503 UNAVAILABLE', durationMs: 12000 },
      'google/gemini-3-flash-preview': { ok: true, durationMs: 650 },
    }
    const stubProbe = async (model) => responses[model] ?? { ok: false, reason: '404', durationMs: 100 }

    const resolved = await probeModelPair({
      orchestratorCandidates: ['google/gemini-4-neon'],
      workerCandidates: ['google/gemini-3.8-flash', 'google/gemini-3-flash-preview'],
      probeFn: stubProbe,
    })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.orchestratorModel, 'google/gemini-4-neon')
    assert.equal(resolved.workerModel, 'google/gemini-3-flash-preview')
    assert.equal(resolved.fallbackUsed, true)

    const exhausted = await probeModelPair({
      orchestratorCandidates: ['google/gemini-4-neon'],
      workerCandidates: ['google/gemini-3.8-flash'],
      probeFn: async () => ({ ok: false, reason: 'HTTP 429 limit: 0', durationMs: 250 }),
    })
    assert.equal(exhausted.ok, false)
    assert.equal(exhausted.attempts.length >= 1, true)
  })

  it('flags fail-fast abort on repeated 429/503 NDJSON retry events past attempt 2', () => {
    const attempt2 = JSON.stringify({
      type: 'retry',
      attempt: 2,
      error: { status: 503, message: 'high demand' },
    })
    const attempt3 = JSON.stringify({
      type: 'retry',
      attempt: 3,
      error: { status: 503, message: 'high demand' },
    })
    const quota429 = JSON.stringify({
      type: 'retry',
      attempt: 3,
      error: { status: 429, message: 'RESOURCE_EXHAUSTED' },
    })

    assert.equal(inspectNdjsonRetryLine(attempt2, { maxRetryAttempts: 2 }), null)
    assert.match(inspectNdjsonRetryLine(attempt3, { maxRetryAttempts: 2 }), /503/)
    assert.match(inspectNdjsonRetryLine(quota429, { maxRetryAttempts: 2 }), /429/)
  })

  it('prepares an isolated greenfield base worktree without mutating main and merges worker diffs cleanly', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orchestrate-greenfield-test-'))
    const repoDir = join(tempDir, 'repo')
    try {
      execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' })
      execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'])
      execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'])
      writeFileSync(join(repoDir, 'README.md'), '# baseline\n')
      writeFileSync(join(repoDir, 'contract.json'), '{"baseline":true}\n')
      writeFileSync(join(repoDir, 'plc.st'), 'PROGRAM Main END_PROGRAM\n')
      execFileSync('git', ['-C', repoDir, 'add', '.'])
      execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'])

      const base = prepareGreenfieldBase({
        repoRoot: repoDir,
        runId: 'gf-test',
        stripFiles: ['contract.json', 'plc.st'],
      })

      try {
        // Main repo still has original files untouched
        assert.equal(existsSync(join(repoDir, 'contract.json')), true)
        assert.equal(existsSync(join(repoDir, 'plc.st')), true)
        // Base worktree has stripped files removed
        assert.equal(existsSync(join(base.baseWorktreePath, 'contract.json')), false)
        assert.equal(existsSync(join(base.baseWorktreePath, 'plc.st')), false)
        assert.equal(existsSync(join(base.baseWorktreePath, 'README.md')), true)
        assert.ok(GREENFIELD_FILES.includes('scenes/conveyor-cell/plc/program.st'))
        assert.equal(GREENFIELD_FILES.includes('openplc/conveyor_cell.st'), false)

        // Simulate worker branched from main authoring plc.st and merging cleanly onto greenfield base
        const workerWt = join(tempDir, 'wt-plc')
        execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', workerWt, 'HEAD'], {
          stdio: 'pipe',
        })
        writeFileSync(join(workerWt, 'plc.st'), 'PROGRAM Generated END_PROGRAM\n')

        const merged = mergeWorkerBranches({
          repoRoot: repoDir,
          runId: 'gf-test',
          baseRef: base.baseBranch,
          workers: [{ name: 'plc-coder', worktreePath: workerWt, ownedFiles: ['plc.st'] }],
        })
        try {
          assert.equal(merged.conflicts, 0)
          assert.deepEqual(merged.mergedBranches[0].filesChanged, ['plc.st'])
          assert.equal(
            readFileSync(join(merged.integrationWorktreePath, 'plc.st'), 'utf8'),
            'PROGRAM Generated END_PROGRAM\n',
          )
        } finally {
          merged.cleanup()
        }
      } finally {
        base.cleanup()
      }
      assert.equal(existsSync(base.baseWorktreePath), false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('builds Stage 1 and greenfield worker prompts without contract/modbus/scene drift', () => {
    const stage1Greenfield = buildStage1Prompt({
      specPath: 'docs/cell-process-spec.md',
      specText: 'PROCESS SPEC',
      workCwd: '/tmp/greenfield-base',
      fromScratch: true,
    })
    assert.match(stage1Greenfield, /\/tmp\/greenfield-base\/openplc\/io-contract\.json/)
    assert.match(
      stage1Greenfield,
      /EStop %IX0\.2 estop_pb\.tag with contact: "NC", TRUE = released\/healthy, FALSE = struck\/tripped/,
    )
    assert.match(stage1Greenfield, /PROCESS SPEC/)

    const stage1Verify = buildStage1Prompt({
      specPath: 'docs/cell-process-spec.md',
      specText: 'VERIFY SPEC',
      workCwd: '/tmp/repo',
      fromScratch: false,
    })
    assert.match(stage1Verify, /Read docs\/cell-process-spec\.md and openplc\/io-contract\.json\./)
    assert.match(stage1Verify, /VERIFY SPEC/)

    const plcPrompt = buildGreenfieldWorkerPrompt({
      workerSpec: WORKER_SPECS.find((w) => w.agent === 'plc-coder'),
      orchestratorBrief: 'BRIEF',
      repoRoot: '/tmp/custom-repo',
    })
    assert.match(plcPrompt, /scenes\/conveyor-cell\/plc\/program\.st/)
    assert.doesNotMatch(plcPrompt, /openplc\/conveyor_cell\.st/)
    assert.match(plcPrompt, /\bderiveModbusMaster\b/)
    assert.doesNotMatch(plcPrompt, /deriveModbusMasterConfig/)
    assert.match(plcPrompt, /ConveyorCellMain/)
    assert.match(plcPrompt, /EStop := NOT EStop/)
    assert.match(plcPrompt, /\/tmp\/custom-repo\/\.tools/)

    const oipPrompt = buildGreenfieldWorkerPrompt({
      workerSpec: WORKER_SPECS.find((w) => w.agent === 'oip-builder'),
      orchestratorBrief: 'BRIEF',
      repoRoot: '/tmp/custom-repo',
    })
    assert.match(oipPrompt, /scenes\/conveyor-cell\/scene\.json/)
    assert.match(oipPrompt, /"plcs": \[\{ "name": "PLC1", "runsOn": "plc", "protocol": "serve", "connect": true \}\]/)

    const testPrompt = buildGreenfieldWorkerPrompt({
      workerSpec: WORKER_SPECS.find((w) => w.agent === 'test-engineer'),
      orchestratorBrief: 'BRIEF',
      repoRoot: '/tmp/custom-repo',
    })
    assert.match(testPrompt, /tests\/conveyor_cell\.test\.st/)
  })
})

function makeFakeAgentTelemetry({
  agent,
  model,
  worktreePath = null,
  skillsLoaded = [],
  finalText = `${agent} ok`,
  startMs = 1700000000000,
  endMs = 1700000000250,
}) {
  return {
    agent,
    model,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(endMs).toISOString(),
    durationMs: endMs - startMs,
    worktreePath,
    sessionId: `ses_${agent}`,
    skillsLoaded,
    toolsUsed: { read: 1, write: 1 },
    tokens: { input: 100, output: 25, reasoning: 5, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.001,
    finalText,
    error: null,
  }
}

function createFakeOrchestrationEnv({
  specPath = 'docs/seam-spec.md',
  includeContract = true,
  mergeConflicts = 0,
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'orchestrate-seam-'))
  const repoDir = join(tempDir, 'repo')
  mkdirSync(join(repoDir, 'docs'), { recursive: true })
  writeFileSync(join(repoDir, specPath), '# Seam Spec\nStart and stop conveyor cell.\n')
  if (includeContract) {
    mkdirSync(join(repoDir, 'openplc'), { recursive: true })
    writeFileSync(
      join(repoDir, 'openplc', 'io-contract.json'),
      JSON.stringify({ signals: [{ name: 'Start_PB' }, { name: 'EStop', contact: 'NC' }] }),
    )
  }

  const openWorktrees = new Set()
  const committedPaths = []
  const linkedTargets = []
  const mergeCalls = []
  const logs = []
  let greenfieldCleanups = 0
  let mergeCleanups = 0

  const workspace = {
    listWorktreePaths: () => new Set([repoDir, ...openWorktrees]),
    removeWorktrees: (paths) => {
      for (const p of paths) openWorktrees.delete(p)
    },
    linkLocalToolchains: (targetDir) => {
      linkedTargets.push(targetDir)
    },
    commitPath: (opts) => {
      committedPaths.push(opts)
    },
    prepareGreenfieldBase: ({ runId, stripFiles }) => {
      const baseWorktreePath = join(tempDir, `wt-base-${runId}`)
      mkdirSync(baseWorktreePath, { recursive: true })
      openWorktrees.add(baseWorktreePath)
      return {
        baseBranch: `orchestrate/${runId}/base`,
        baseWorktreePath,
        stripFiles,
        cleanup: () => {
          greenfieldCleanups += 1
          openWorktrees.delete(baseWorktreePath)
        },
      }
    },
    mergeWorkerBranches: ({ runId, baseRef, workers }) => {
      mergeCalls.push({ runId, baseRef, workers })
      const integrationWorktreePath = join(tempDir, `wt-int-${runId}`)
      mkdirSync(integrationWorktreePath, { recursive: true })
      openWorktrees.add(integrationWorktreePath)
      return {
        integrationBranch: `orchestrate/${runId}/integration`,
        integrationWorktreePath,
        conflicts: mergeConflicts,
        mergedBranches: workers.map((w) => ({
          worker: w.name,
          branch: `orchestrate/${runId}/${w.name}`,
          commitSha: 'abc1234',
          mergeSha: mergeConflicts === 0 ? 'def5678' : undefined,
          filesChanged: w.ownedFiles ?? [`${w.name}.txt`],
        })),
        cleanup: () => {
          mergeCleanups += 1
          openWorktrees.delete(integrationWorktreePath)
          for (const w of workers) openWorktrees.delete(w.worktreePath)
        },
      }
    },
  }

  const agentCalls = []
  const writeProofCalls = []
  const gateCalls = []

  const createRunAgent = ({ onStage1, onWorker, onRepair } = {}) => async (opts) => {
    agentCalls.push(opts)
    if (opts.worktreeName) {
      const wt = join(tempDir, `wt-${opts.agent}`)
      mkdirSync(wt, { recursive: true })
      openWorktrees.add(wt)
      if (onWorker) {
        const custom = await onWorker(opts, wt)
        if (custom !== undefined) return custom
      }
      const expectedSkill = WORKER_SPECS.find((w) => w.agent === opts.agent)?.expectedSkill
      return makeFakeAgentTelemetry({
        agent: opts.agent,
        model: opts.model,
        worktreePath: wt,
        skillsLoaded: expectedSkill ? [expectedSkill] : [],
      })
    }
    if (opts.cwd !== repoDir && !opts.cwd.includes('wt-base-')) {
      if (onRepair) {
        const custom = await onRepair(opts)
        if (custom !== undefined) return custom
      }
      return makeFakeAgentTelemetry({
        agent: opts.agent,
        model: opts.model,
        finalText: 'Applied targeted repair.',
      })
    }
    if (onStage1) {
      const custom = await onStage1(opts)
      if (custom !== undefined) return custom
    }
    return makeFakeAgentTelemetry({
      agent: opts.agent,
      model: opts.model,
      finalText: '3-bullet brief',
    })
  }

  return {
    tempDir,
    repoDir,
    specPath,
    openWorktrees,
    committedPaths,
    linkedTargets,
    mergeCalls,
    agentCalls,
    writeProofCalls,
    gateCalls,
    logs,
    get greenfieldCleanups() {
      return greenfieldCleanups
    },
    get mergeCleanups() {
      return mergeCleanups
    },
    workspace,
    createRunAgent,
    writeProof: (payload) => writeProofCalls.push(payload),
    log: (msg) => logs.push(msg),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

describe('runOrchestration offline seam tests', () => {
  it('completes verify happy path, defaults proof output to repoRoot, and leaks zero worktrees', async () => {
    const env = createFakeOrchestrationEnv({ specPath: 'docs/seam-spec.md', includeContract: true })
    try {
      const proof = await runOrchestration({
        specPath: env.specPath,
        repoRoot: env.repoDir,
        resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
        probeModels: async () => {
          throw new Error('probeModels should not run when usePreflight is false')
        },
        workspace: env.workspace,
        runAgent: env.createRunAgent(),
        runGate: (label, cmd, args, cwd) => {
          env.gateCalls.push({ label, cmd, args, cwd })
          return { label, passed: true, durationMs: 5, summary: 'PASS' }
        },
        log: env.log,
      })

      assert.equal(proof.mode, 'verify')
      assert.equal(proof.repairAttempts, 0)
      assert.equal(proof.repairPass, undefined)
      assert.equal(proof.orchestrator.model, 'test/orch')
      assert.equal(proof.workers.length, 3)
      assert.deepEqual(
        env.gateCalls.map((g) => g.label),
        ['test:contract', 'plc:test', 'oip:validate', 'test:e2e'],
      )
      assert.equal(proof.verification.contractTest.passed, true)
      assert.equal(proof.verification.plcTest.passed, true)
      assert.equal(proof.verification.oipValidate.passed, true)
      assert.equal(proof.verification.e2eModbus.passed, true)
      assert.equal(existsSync(join(env.repoDir, 'docs', 'orchestration-proof.json')), true)
      assert.equal(existsSync(join(env.repoDir, 'docs', 'orchestration-proof.md')), true)
      assert.equal(env.agentCalls[0].cwd, env.repoDir)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })

  it('completes fromScratch + usePreflight happy path with injected adapters and zero leaked worktrees', async () => {
    const env = createFakeOrchestrationEnv({ specPath: 'docs/seam-spec.md', includeContract: false })
    let probeCalls = 0
    try {
      const proof = await runOrchestration({
        specPath: env.specPath,
        usePreflight: true,
        fromScratch: true,
        repoRoot: env.repoDir,
        resolveModels: () => {
          throw new Error('resolveModels should not run when probeModels resolves both models')
        },
        probeModels: async () => {
          probeCalls += 1
          return {
            ok: true,
            orchestratorModel: 'probe/orch',
            workerModel: 'probe/worker',
            fallbackUsed: true,
            attempts: [],
          }
        },
        workspace: env.workspace,
        runAgent: env.createRunAgent({
          onStage1: (opts) => {
            mkdirSync(join(opts.cwd, 'openplc'), { recursive: true })
            writeFileSync(
              join(opts.cwd, 'openplc', 'io-contract.json'),
              JSON.stringify({ signals: [{ name: 'Start_PB' }, { name: 'EStop', contact: 'NC' }] }),
            )
          },
        }),
        runGate: (label, cmd, args, cwd) => {
          env.gateCalls.push({ label, cmd, args, cwd })
          return { label, passed: true, durationMs: 5, summary: 'PASS' }
        },
        writeProof: env.writeProof,
        log: env.log,
      })

      assert.equal(probeCalls, 1)
      assert.equal(proof.mode, 'from-scratch')
      assert.equal(proof.repairAttempts, 0)
      assert.equal(proof.orchestrator.model, 'probe/orch')
      assert.equal(proof.workers[0].model, 'probe/worker')
      assert.equal(env.committedPaths.length, 1)
      assert.equal(env.committedPaths[0].pathSpec, 'openplc/io-contract.json')
      assert.notEqual(env.agentCalls[0].cwd, env.repoDir)
      assert.match(env.agentCalls[0].prompt, /contact: "NC"/)
      const plcCall = env.agentCalls.find((c) => c.agent === 'plc-coder')
      assert.match(plcCall.prompt, /\bderiveModbusMaster\b/)
      assert.match(plcCall.prompt, /EStop := NOT EStop/)
      assert.ok(plcCall.prompt.includes(`${env.repoDir}/.tools`))
      const oipCall = env.agentCalls.find((c) => c.agent === 'oip-builder')
      assert.match(oipCall.prompt, /"plcs":/)
      assert.ok(env.mergeCalls[0].baseRef.endsWith('/base'))
      assert.deepEqual(
        env.gateCalls.map((g) => g.label),
        ['test:contract', 'plc:test', 'oip:validate', 'test:e2e'],
      )
      assert.equal(env.writeProofCalls.length, 1)
      assert.equal(env.writeProofCalls[0].repoRoot, env.repoDir)
      assert.equal(env.greenfieldCleanups, 1)
      assert.equal(env.mergeCleanups, 1)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })

  it('rejects Stage 1 failure in fromScratch mode when io-contract.json is missing or agent fails, skips Stage 2, and cleans up greenfieldBase', async () => {
    const env = createFakeOrchestrationEnv({ specPath: 'docs/seam-spec.md', includeContract: false })
    try {
      await assert.rejects(
        runOrchestration({
          specPath: env.specPath,
          fromScratch: true,
          repoRoot: env.repoDir,
          resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
          workspace: env.workspace,
          runAgent: env.createRunAgent(), // Resolves without writing openplc/io-contract.json
          runGate: () => {
            throw new Error('runGate must not execute on Stage 1 failure')
          },
          writeProof: env.writeProof,
          log: env.log,
        }),
        /Orchestrator did not write .*openplc\/io-contract\.json/,
      )

      assert.equal(env.agentCalls.length, 1)
      assert.equal(env.mergeCalls.length, 0)
      assert.equal(env.writeProofCalls.length, 0)
      assert.equal(env.greenfieldCleanups, 1)
      assert.equal(env.openWorktrees.size, 0)

      await assert.rejects(
        runOrchestration({
          specPath: env.specPath,
          fromScratch: true,
          repoRoot: env.repoDir,
          resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
          workspace: env.workspace,
          runAgent: env.createRunAgent({
            onStage1: () => {
              throw new Error('Stage 1 provider error')
            },
          }),
          runGate: () => {
            throw new Error('runGate must not execute on Stage 1 rejection')
          },
          writeProof: env.writeProof,
          log: env.log,
        }),
        /Stage 1 provider error/,
      )

      assert.equal(env.agentCalls.length, 2)
      assert.equal(env.mergeCalls.length, 0)
      assert.equal(env.writeProofCalls.length, 0)
      assert.equal(env.greenfieldCleanups, 2)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })

  it('aborts Stage 2 fail-fast when a worker rejects, removes all sibling worktrees, and skips Stage 3', async () => {
    const env = createFakeOrchestrationEnv({ specPath: 'docs/seam-spec.md', includeContract: true })
    try {
      await assert.rejects(
        runOrchestration({
          specPath: env.specPath,
          repoRoot: env.repoDir,
          resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
          workspace: env.workspace,
          runAgent: env.createRunAgent({
            onWorker: async (opts) => {
              if (opts.agent === 'oip-builder') {
                throw new Error('Agent "oip-builder" Fail-fast abort on HTTP 503 retry attempt 3')
              }
            },
          }),
          runGate: () => {
            throw new Error('runGate must not execute when Stage 2 aborts')
          },
          writeProof: env.writeProof,
          log: env.log,
        }),
        /Fail-fast abort on HTTP 503/,
      )

      assert.equal(env.agentCalls.length, 4)
      assert.equal(env.mergeCalls.length, 0)
      assert.equal(env.writeProofCalls.length, 0)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })

  it('rejects on Stage 3 merge conflict, runs merge cleanup and worktree cleanup, and skips Stage 4', async () => {
    const env = createFakeOrchestrationEnv({
      specPath: 'docs/seam-spec.md',
      includeContract: true,
      mergeConflicts: 1,
    })
    try {
      await assert.rejects(
        runOrchestration({
          specPath: env.specPath,
          repoRoot: env.repoDir,
          resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
          workspace: env.workspace,
          runAgent: env.createRunAgent(),
          runGate: (label) => {
            env.gateCalls.push({ label })
            return { label, passed: true, durationMs: 5, summary: 'PASS' }
          },
          writeProof: env.writeProof,
          log: env.log,
        }),
        /Merge produced 1 conflict\(s\)/,
      )

      assert.equal(env.mergeCalls.length, 1)
      assert.equal(env.mergeCleanups, 1)
      assert.equal(env.gateCalls.length, 0)
      assert.equal(env.writeProofCalls.length, 0)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })

  it('recovers via one post-merge Orchestrator repair pass when test:contract fails initially', async () => {
    const env = createFakeOrchestrationEnv({ specPath: 'docs/seam-spec.md', includeContract: true })
    let gatePassRound = 0
    try {
      const proof = await runOrchestration({
        specPath: env.specPath,
        repoRoot: env.repoDir,
        resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
        workspace: env.workspace,
        runAgent: env.createRunAgent(),
        runGate: (label) => {
          if (label === 'test:contract') gatePassRound += 1
          env.gateCalls.push({ label, round: gatePassRound })
          if (gatePassRound === 1 && label === 'test:contract') {
            return { label, passed: false, durationMs: 4, summary: 'EStop missing contact: "NC"' }
          }
          return { label, passed: true, durationMs: 4, summary: 'PASS' }
        },
        writeProof: env.writeProof,
        log: env.log,
      })

      assert.deepEqual(
        env.gateCalls.map((g) => g.label),
        ['test:contract', 'plc:test', 'oip:validate', 'test:contract', 'plc:test', 'oip:validate', 'test:e2e'],
      )
      assert.equal(proof.repairAttempts, 1)
      assert.ok(proof.repairPass)
      assert.equal(proof.repairPass.agent, 'orchestrator')
      const repairCall = env.agentCalls[4]
      assert.equal(repairCall.agent, 'orchestrator')
      assert.match(repairCall.prompt, /test:contract \(FAIL\):\nEStop missing contact: "NC"/)
      assert.equal(env.writeProofCalls.length, 1)
      assert.equal(env.mergeCleanups, 1)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })

  it('rejects when post-merge repair budget is exhausted without writing proof or leaking worktrees', async () => {
    const env = createFakeOrchestrationEnv({ specPath: 'docs/seam-spec.md', includeContract: true })
    let round = 0
    try {
      await assert.rejects(
        runOrchestration({
          specPath: env.specPath,
          repoRoot: env.repoDir,
          resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
          workspace: env.workspace,
          runAgent: env.createRunAgent(),
          runGate: (label) => {
            if (label === 'test:contract') round += 1
            env.gateCalls.push({ label, round })
            if (round === 1 && label === 'plc:test') {
              return { label, passed: false, durationMs: 4, summary: 'PLC test fail' }
            }
            if (round === 2 && label === 'test:e2e') {
              return { label, passed: false, durationMs: 4, summary: 'E2E modbus timeout' }
            }
            return { label, passed: true, durationMs: 4, summary: 'PASS' }
          },
          writeProof: env.writeProof,
          log: env.log,
        }),
        /Verification gate failed after repair budget exhausted/,
      )

      assert.equal(env.agentCalls.length, 5) // 1 stage1 + 3 workers + 1 repair
      assert.deepEqual(
        env.gateCalls.map((g) => g.label),
        ['test:contract', 'plc:test', 'oip:validate', 'test:contract', 'plc:test', 'oip:validate', 'test:e2e'],
      )
      assert.equal(env.writeProofCalls.length, 0)
      assert.equal(env.mergeCleanups, 1)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })
})
