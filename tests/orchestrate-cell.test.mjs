import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  GREENFIELD_FILES,
  inspectNdjsonRetryLine,
  mergeWorkerBranches,
  parseOpenCodeNdjson,
  prepareGreenfieldBase,
} from '../scripts/orchestrate-cell.mjs'
import {
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

    // First post-merge failure triggers repair pass; second exhausts budget and cleans up all worktrees
    state = transition(state, { type: 'GATE_FAIL_REPAIR' })
    assert.equal(state.phase, 'stage4_repair')
    assert.equal(state.repairAttempts, 1)

    state = transition(state, { type: 'REPAIR_PATCH_APPLIED' })
    assert.equal(state.phase, 'stage4_verify')

    state = transition(state, { type: 'GATE_FAIL_REPAIR' })
    assert.equal(state.phase, 'failed')
    assert.equal(state.leakedWorktrees, 0)

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
        assert.ok(GREENFIELD_FILES.includes('openplc/conveyor_cell.st'))

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
})
