import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { probeModelPair, probeSingleModel } from '../scripts/opencode-probe.mjs'
import {
  buildStage1Prompt,
  buildWorkerPrompt,
  buildWorkerSpecs,
  generateCell,
  inspectNdjsonRetryLine,
  mergeWorkerBranches,
  parseOpenCodeNdjson,
  prepareGreenfieldBase,
  slugifyPrompt,
} from '../scripts/orchestrate-cell.mjs'
import {
  createGates,
  createInitialState,
  transition,
} from '../scripts/orchestration-machine.mjs'

const SAMPLE_CATALOG = {
  parts: [
    {
      id: 'oip.roller-conveyor',
      name: 'Roller Conveyor',
      signals: [{ name: 'runTag', dir: 'in', type: 'BOOL' }],
    },
    {
      id: 'oip.color-sensor',
      name: 'Color Sensor',
      signals: [{ name: 'colorTag', dir: 'out', type: 'INT' }],
    },
    {
      id: 'oip.diverter',
      name: 'Diverter',
      signals: [{ name: 'tag', dir: 'in', type: 'BOOL' }],
    },
  ],
}

function makeValidContract(slug = 'color-sorter') {
  return {
    name: slug,
    version: '1.0.0',
    plc: { functionBlockName: 'ColorSorterController', programName: 'ColorSorterMain' },
    modbus: {
      topology: 'oip-server-openplc-master',
      oipHostForPlc: 'host.docker.internal',
      port: 5020,
      slaveId: 1,
      cycleTimeMs: 50,
    },
    parameters: { scanIntervalMs: 20 },
    signals: [
      {
        name: 'Color_Code',
        iecAddress: '%IW0',
        type: 'INT',
        direction: 'oip_to_plc',
        modbusArea: 'inputRegister',
        modbusAddress: 0,
        sceneRole: { partId: 'color_1', param: 'colorTag', packageId: 'oip.color-sensor' },
        description: 'Detected box color code',
      },
      {
        name: 'Diverter_Cmd',
        iecAddress: '%QX0.0',
        type: 'BOOL',
        direction: 'plc_to_oip',
        modbusArea: 'coil',
        modbusAddress: 0,
        sceneRole: { partId: 'diverter_1', param: 'tag', packageId: 'oip.diverter' },
        description: 'Diverter actuator command',
      },
    ],
  }
}

describe('Parallel git worktree orchestration primitives', () => {
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

  it('enforces legal orchestration state transitions, bounded repairs, and zero leaked worktrees', () => {
    let state = createInitialState({ maxWorkerSelfHeals: 2, maxPostMergeRepairs: 1 })
    assert.deepEqual(state.gates, createGates('pending'))
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

    state = transition(state, { type: 'WORKER_SUCCEED', worker: 'plc-coder' })
    const illegal = transition(state, { type: 'MERGE_CLEAN' })
    assert.equal(illegal.lastRejected, true)

    state = transition(state, { type: 'WORKER_SUCCEED', worker: 'oip-builder' })
    state = transition(state, { type: 'WORKER_SUCCEED', worker: 'test-engineer' })
    state = transition(state, { type: 'MERGE_CLEAN' })
    state = transition(state, {
      type: 'GATE_FAIL_REPAIR',
      gates: { contractTest: 'fail', plcTest: 'pass', oipValidate: 'pass' },
    })
    assert.equal(state.phase, 'stage4_repair')
    assert.equal(state.repairAttempts, 1)

    state = transition(state, { type: 'REPAIR_PATCH_APPLIED' })
    state = transition(state, { type: 'GATE_FAIL_REPAIR' })
    assert.equal(state.phase, 'failed')
    assert.equal(state.leakedWorktrees, 0)
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

    const chunkSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.killed = false
      child.kill = () => {
        child.killed = true
      }
      queueMicrotask(() => {
        const line = JSON.stringify({
          type: 'retry',
          attempt: 2,
          error: { status: 503, message: 'high demand' },
        })
        child.stdout.emit('data', Buffer.from(line.slice(0, 20)))
        child.stdout.emit('data', Buffer.from(`${line.slice(20)}\n`))
      })
      return child
    }

    const aborted = await probeSingleModel('google/gemini-3.8-flash', {
      timeoutMs: 2000,
      spawnFn: chunkSpawn,
    })
    assert.equal(aborted.ok, false)
    assert.match(aborted.reason, /503/)
  })

  it('probes prioritized model candidates with fallback and inspects 429/503 retries', async () => {
    const resolved = await probeModelPair({
      orchestratorCandidates: ['google/gemini-4-neon'],
      workerCandidates: ['google/gemini-3.8-flash', 'google/gemini-3-flash-preview'],
      probeFn: async (m) =>
        m === 'google/gemini-3.8-flash'
          ? { ok: false, reason: 'HTTP 503', durationMs: 100 }
          : { ok: true, durationMs: 50 },
    })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.workerModel, 'google/gemini-3-flash-preview')
    assert.equal(resolved.fallbackUsed, true)

    const retry3 = JSON.stringify({ type: 'retry', attempt: 3, error: { status: 503, message: 'busy' } })
    assert.match(inspectNdjsonRetryLine(retry3, { maxRetryAttempts: 2 }), /503/)
  })

  it('generates clean slugs and builds generic zero-leakage Stage 1 and Stage 2 prompts', () => {
    assert.equal(slugifyPrompt('A Color-Sorting Roller Line with Diverter!'), 'a-color-sorting-roller-line')
    assert.equal(slugifyPrompt('   '), 'generated-cell')

    const stage1 = buildStage1Prompt({
      slug: 'color-sorter',
      promptText: 'A roller conveyor that diverts red boxes.',
      workCwd: '/tmp/wt',
      catalogSummary: '- oip.color-sensor (Color Sensor): colorTag(out:INT)',
    })
    assert.match(stage1, /scenes\/color-sorter\/io-contract\.json/)
    assert.match(stage1, /scenes\/color-sorter\/process-spec\.md/)
    assert.match(stage1, /oip\.color-sensor/)
    assert.match(stage1, /UNSUPPORTED_HARDWARE/)
    assert.doesNotMatch(stage1, /ConveyorCell|BATCH_TARGET|belt_1|0\.35,1\.25,0|PhotoEye/)

    for (const workerSpec of buildWorkerSpecs('color-sorter')) {
      const prompt = buildWorkerPrompt({
        slug: 'color-sorter',
        workerSpec,
        orchestratorBrief: 'BRIEF',
        repoRoot: '/tmp/repo',
        contractJson: JSON.stringify(makeValidContract('color-sorter')),
        specText: '# Color Sorter',
      })
      assert.match(prompt, /scenes\/color-sorter\/io-contract\.json/)
      assert.doesNotMatch(prompt, /ConveyorCell|BATCH_TARGET|belt_1|0\.35,1\.25,0|PhotoEye/)
    }
  })

  it('prepares isolated greenfield base worktree without mutating main', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orchestrate-greenfield-test-'))
    const repoDir = join(tempDir, 'repo')
    try {
      execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' })
      execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'])
      execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'])
      writeFileSync(join(repoDir, 'README.md'), '# baseline\n')
      execFileSync('git', ['-C', repoDir, 'add', '.'])
      execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'])

      const base = prepareGreenfieldBase({ repoRoot: repoDir, runId: 'gf-test', stripFiles: [] })
      try {
        assert.equal(existsSync(join(base.baseWorktreePath, 'README.md')), true)
      } finally {
        base.cleanup()
      }
      assert.equal(existsSync(base.baseWorktreePath), false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

function makeFakeTelemetry({
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

function createFakeGeneratorEnv() {
  const tempDir = mkdtempSync(join(tmpdir(), 'generate-cell-seam-'))
  const repoDir = join(tempDir, 'repo')
  mkdirSync(join(repoDir, 'scenes', 'conveyor-cell'), { recursive: true })

  const openWorktrees = new Set()
  const committedPaths = []
  const events = []
  const agentCalls = []
  const runCellCalls = []

  const workspace = {
    listWorktreePaths: () => new Set([repoDir, ...openWorktrees]),
    removeWorktrees: (paths) => {
      for (const p of paths) openWorktrees.delete(p)
    },
    linkLocalToolchains: () => {},
    commitPath: (opts) => committedPaths.push(opts),
    prepareGreenfieldBase: ({ runId }) => {
      const baseWorktreePath = join(tempDir, `wt-base-${runId}`)
      mkdirSync(baseWorktreePath, { recursive: true })
      openWorktrees.add(baseWorktreePath)
      return {
        baseBranch: `orchestrate/${runId}/base`,
        baseWorktreePath,
        cleanup: () => openWorktrees.delete(baseWorktreePath),
      }
    },
    mergeWorkerBranches: ({ runId, workers }) => {
      const integrationWorktreePath = join(tempDir, `wt-int-${runId}`)
      mkdirSync(integrationWorktreePath, { recursive: true })
      openWorktrees.add(integrationWorktreePath)
      // Copy base & worker files into integrationWorktreePath so persistence test sees real files
      for (const w of workers) {
        const slugDir = join(w.worktreePath, 'scenes')
        if (existsSync(slugDir)) {
          execFileSync('cp', ['-R', slugDir, integrationWorktreePath])
        }
      }
      return {
        integrationBranch: `orchestrate/${runId}/integration`,
        integrationWorktreePath,
        conflicts: 0,
        mergedBranches: workers.map((w) => ({
          worker: w.name,
          branch: `orchestrate/${runId}/${w.name}`,
          commitSha: 'abc1234',
          mergeSha: 'def5678',
          filesChanged: w.ownedFiles ?? [],
        })),
        cleanup: () => {
          openWorktrees.delete(integrationWorktreePath)
          for (const w of workers) openWorktrees.delete(w.worktreePath)
        },
      }
    },
  }

  return {
    tempDir,
    repoDir,
    openWorktrees,
    committedPaths,
    events,
    agentCalls,
    runCellCalls,
    workspace,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

describe('generateCell programmatic seam tests', () => {
  it('runs Stage 1 -> catalog validation -> deterministic modbus -> Stage 2 workers -> Stage 4 verify -> persists Cell & report', async () => {
    const env = createFakeGeneratorEnv()
    const slug = 'color-sorter'
    const contract = makeValidContract(slug)

    try {
      const result = await generateCell({
        prompt: 'A color sorting roller line with diverter.',
        name: slug,
        repoRoot: env.repoDir,
        resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
        loadCatalog: () => SAMPLE_CATALOG,
        workspace: env.workspace,
        onEvent: (ev) => env.events.push(ev),
        runAgent: async (opts) => {
          env.agentCalls.push(opts)
          if (!opts.worktreeName) {
            const cellDir = join(opts.cwd, 'scenes', slug)
            mkdirSync(cellDir, { recursive: true })
            writeFileSync(join(cellDir, 'io-contract.json'), JSON.stringify(contract, null, 2))
            writeFileSync(join(cellDir, 'process-spec.md'), '# Color Sorter\n')
            return makeFakeTelemetry({ agent: 'orchestrator', model: opts.model, finalText: '3-bullet brief' })
          }
          const wt = join(env.tempDir, `wt-${opts.agent}`)
          const cellDir = join(wt, 'scenes', slug)
          mkdirSync(join(cellDir, 'plc'), { recursive: true })
          mkdirSync(join(cellDir, 'tests'), { recursive: true })
          env.openWorktrees.add(wt)
          if (opts.agent === 'plc-coder') {
            writeFileSync(join(cellDir, 'plc', 'program.st'), 'FUNCTION_BLOCK ColorSorterController END_FUNCTION_BLOCK\n')
          } else if (opts.agent === 'oip-builder') {
            writeFileSync(join(cellDir, 'project.json'), JSON.stringify({ version: 7, name: slug }))
            writeFileSync(join(cellDir, 'scene.json'), JSON.stringify({ version: 4, parts: [], plcs: [] }))
          } else {
            writeFileSync(join(cellDir, 'tests', 'program.test.st'), "TEST 'ok' END_TEST\n")
          }
          const spec = buildWorkerSpecs(slug).find((w) => w.agent === opts.agent)
          return makeFakeTelemetry({
            agent: opts.agent,
            model: opts.model,
            worktreePath: wt,
            skillsLoaded: [spec.expectedSkill],
          })
        },
        verifyCellFn: ({ slug: s, repoRoot: cwd }) => {
          assert.equal(s, slug)
          assert.ok(existsSync(join(cwd, 'scenes', slug, 'plc', 'program.st')))
          return {
            ok: true,
            slug: s,
            gates: {
              contract: { passed: true, problems: [] },
              plcTest: { passed: true, summary: '1 passed' },
              oipValidate: { passed: true, warnings: ['spawner_1: minor spacing warning'], summary: 'ok' },
            },
            warnings: ['spawner_1: minor spacing warning'],
          }
        },
        deploy: true,
        runCellFn: async (opts) => {
          env.runCellCalls.push(opts)
          return { slug: opts.slug, deployed: { plcStatus: 'RUNNING' }, launched: false }
        },
        log: () => {},
      })

      assert.equal(result.ok, true)
      assert.equal(result.slug, slug)
      assert.equal(env.openWorktrees.size, 0)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'io-contract.json')), true)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'plc', 'modbus_master.json')), true)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'plc', 'program.st')), true)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'scene.json')), true)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'tests', 'program.test.st')), true)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'generation-report.json')), true)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'generation-report.md')), true)

      const modbus = JSON.parse(readFileSync(join(env.repoDir, 'scenes', slug, 'plc', 'modbus_master.json'), 'utf8'))
      assert.equal(modbus[0].config.io_points[0].fc, 4)
      assert.equal(modbus[0].config.io_points[1].fc, 15)

      const reportMd = readFileSync(join(env.repoDir, 'scenes', slug, 'generation-report.md'), 'utf8')
      assert.match(reportMd, /spawner_1: minor spacing warning/)
      assert.equal(env.runCellCalls.length, 1)
      assert.equal(env.runCellCalls[0].deployOnly, true)
      assert.ok(env.events.some((e) => e.stage === 'stage1'))
      assert.ok(env.events.some((e) => e.stage === 'done'))
    } finally {
      env.cleanup()
    }
  })

  it('protects Task 1 conveyor-cell unconditionally and existing Cells unless force is true', async () => {
    const env = createFakeGeneratorEnv()
    try {
      await assert.rejects(
        () =>
          generateCell({
            prompt: 'test',
            name: 'conveyor-cell',
            force: true,
            repoRoot: env.repoDir,
            log: () => {},
          }),
        /protected Task 1/i,
      )

      mkdirSync(join(env.repoDir, 'scenes', 'existing-cell'), { recursive: true })
      await assert.rejects(
        () =>
          generateCell({
            prompt: 'test',
            name: 'existing-cell',
            force: false,
            repoRoot: env.repoDir,
            log: () => {},
          }),
        /already exists.*--force/i,
      )
    } finally {
      env.cleanup()
    }
  })

  it('runs one Stage 1 repair when contract fails catalog validation, and rejects UNSUPPORTED_HARDWARE without spawning workers', async () => {
    const env = createFakeGeneratorEnv()
    const slug = 'repair-s1'
    let stage1Calls = 0
    try {
      const res = await generateCell({
        prompt: 'color sorter',
        name: slug,
        stage1Only: true,
        repoRoot: env.repoDir,
        resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
        loadCatalog: () => SAMPLE_CATALOG,
        workspace: env.workspace,
        runAgent: async (opts) => {
          stage1Calls += 1
          const cellDir = join(opts.cwd, 'scenes', slug)
          mkdirSync(cellDir, { recursive: true })
          const contract = makeValidContract(slug)
          if (stage1Calls === 1) {
            contract.signals[0].sceneRole.param = 'wrongParam'
          }
          writeFileSync(join(cellDir, 'io-contract.json'), JSON.stringify(contract, null, 2))
          writeFileSync(join(cellDir, 'process-spec.md'), '# Spec\n')
          return makeFakeTelemetry({ agent: 'orchestrator', model: opts.model, finalText: 'brief' })
        },
        log: () => {},
      })

      assert.equal(res.ok, true)
      assert.equal(res.mode, 'stage1-only')
      assert.equal(stage1Calls, 2)
      assert.equal(existsSync(join(env.repoDir, 'scenes', slug, 'plc', 'modbus_master.json')), true)
      assert.equal(env.openWorktrees.size, 0)

      // Unsupported hardware must fail fast before Stage 2
      await assert.rejects(
        () =>
          generateCell({
            prompt: 'build a laser welding cell',
            name: 'laser-welder',
            repoRoot: env.repoDir,
            resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
            loadCatalog: () => SAMPLE_CATALOG,
            workspace: env.workspace,
            runAgent: async (opts) =>
              makeFakeTelemetry({
                agent: 'orchestrator',
                model: opts.model,
                finalText: 'UNSUPPORTED_HARDWARE: OIP has no laser welder part.',
              }),
            log: () => {},
          }),
        /UNSUPPORTED_HARDWARE.*laser welder/i,
      )
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })

  it('recovers via one Stage 4 orchestrator repair pass and rejects cleanly when repair budget is exhausted', async () => {
    const env = createFakeGeneratorEnv()
    const slug = 'repair-s4'
    const contract = makeValidContract(slug)
    let verifyCalls = 0
    try {
      const res = await generateCell({
        prompt: 'color sorter',
        name: slug,
        repoRoot: env.repoDir,
        resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
        loadCatalog: () => SAMPLE_CATALOG,
        workspace: env.workspace,
        runAgent: async (opts) => {
          if (!opts.worktreeName && opts.cwd.includes('wt-base-')) {
            const cellDir = join(opts.cwd, 'scenes', slug)
            mkdirSync(cellDir, { recursive: true })
            writeFileSync(join(cellDir, 'io-contract.json'), JSON.stringify(contract, null, 2))
            writeFileSync(join(cellDir, 'process-spec.md'), '# Spec\n')
            return makeFakeTelemetry({ agent: 'orchestrator', model: opts.model, finalText: 'brief' })
          }
          if (!opts.worktreeName) {
            return makeFakeTelemetry({ agent: 'orchestrator', model: opts.model, finalText: 'repaired' })
          }
          const wt = join(env.tempDir, `wt-${opts.agent}`)
          mkdirSync(join(wt, 'scenes', slug, 'plc'), { recursive: true })
          env.openWorktrees.add(wt)
          const spec = buildWorkerSpecs(slug).find((w) => w.agent === opts.agent)
          return makeFakeTelemetry({ agent: opts.agent, model: opts.model, worktreePath: wt, skillsLoaded: [spec.expectedSkill] })
        },
        verifyCellFn: () => {
          verifyCalls += 1
          if (verifyCalls === 1) {
            return {
              ok: false,
              slug,
              gates: {
                contract: { passed: true, problems: [] },
                plcTest: { passed: false, summary: 'ASSERT_TRUE failed' },
                oipValidate: { passed: true, warnings: [], summary: 'ok' },
              },
              warnings: [],
            }
          }
          return {
            ok: true,
            slug,
            gates: {
              contract: { passed: true, problems: [] },
              plcTest: { passed: true, summary: 'ok' },
              oipValidate: { passed: true, warnings: [], summary: 'ok' },
            },
            warnings: [],
          }
        },
        log: () => {},
      })

      assert.equal(res.ok, true)
      assert.equal(res.repairAttempts, 1)
      assert.ok(res.totals.costUsd > 0)
      assert.equal(verifyCalls, 2)
      assert.equal(env.openWorktrees.size, 0)

      // Exhausted repair budget must reject, persist nothing, and leak zero worktrees
      await assert.rejects(
        () =>
          generateCell({
            prompt: 'color sorter',
            name: 'repair-exhausted',
            repoRoot: env.repoDir,
            resolveModels: () => ({ orchestrator: 'test/orch', worker: 'test/worker' }),
            loadCatalog: () => SAMPLE_CATALOG,
            workspace: env.workspace,
            runAgent: async (opts) => {
              if (!opts.worktreeName && opts.cwd.includes('wt-base-')) {
                const cellDir = join(opts.cwd, 'scenes', 'repair-exhausted')
                mkdirSync(cellDir, { recursive: true })
                writeFileSync(join(cellDir, 'io-contract.json'), JSON.stringify(makeValidContract('repair-exhausted'), null, 2))
                writeFileSync(join(cellDir, 'process-spec.md'), '# Spec\n')
                return makeFakeTelemetry({ agent: 'orchestrator', model: opts.model, finalText: 'brief' })
              }
              if (!opts.worktreeName) {
                return makeFakeTelemetry({ agent: 'orchestrator', model: opts.model, finalText: 'attempted fix' })
              }
              const wt = join(env.tempDir, `wt-ex-${opts.agent}`)
              mkdirSync(join(wt, 'scenes', 'repair-exhausted', 'plc'), { recursive: true })
              env.openWorktrees.add(wt)
              const spec = buildWorkerSpecs('repair-exhausted').find((w) => w.agent === opts.agent)
              return makeFakeTelemetry({ agent: opts.agent, model: opts.model, worktreePath: wt, skillsLoaded: [spec.expectedSkill] })
            },
            verifyCellFn: () => ({
              ok: false,
              slug: 'repair-exhausted',
              gates: {
                contract: { passed: true, problems: [] },
                plcTest: { passed: false, summary: 'still failing' },
                oipValidate: { passed: true, warnings: [], summary: 'ok' },
              },
              warnings: [],
            }),
            log: () => {},
          }),
        /repair budget exhausted/i,
      )
      assert.equal(existsSync(join(env.repoDir, 'scenes', 'repair-exhausted')), false)
      assert.equal(env.openWorktrees.size, 0)
    } finally {
      env.cleanup()
    }
  })
})
