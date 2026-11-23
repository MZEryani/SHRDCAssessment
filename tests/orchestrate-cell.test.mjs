import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  mergeWorkerBranches,
  parseOpenCodeNdjson,
} from '../scripts/orchestrate-cell.mjs'

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

    // Verify clean merge and passing gates
    assert.equal(proof.merge.conflicts, 0)
    assert.equal(proof.merge.mergedBranches.length, 3)
    assert.equal(proof.verification.plcTest.passed, true)
    assert.equal(proof.verification.oipValidate.passed, true)
    assert.equal(proof.verification.e2eModbus.passed, true)
  })
})
