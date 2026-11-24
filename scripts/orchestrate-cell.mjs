#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createGitWorktreeWorkspace,
  mergeWorkerBranches,
  prepareGreenfieldBase,
} from './git-worktree-workspace.mjs'
import {
  inspectNdjsonRetryLine,
  parseOpenCodeNdjson,
  probeModelPair,
  resolveDefaultModels,
  runOpenCodeAgent,
} from './opencode-runner.mjs'
import { createInitialState, transition } from './orchestration-machine.mjs'

export {
  inspectNdjsonRetryLine,
  mergeWorkerBranches,
  parseOpenCodeNdjson,
  prepareGreenfieldBase,
}

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

function stepMachine(machine, event) {
  const next = transition(machine, event)
  if (next.lastRejected) {
    throw new Error(`Orchestration state machine rejected ${event.type}: ${next.lastMessage}`)
  }
  return next
}

function defaultRunGate(label, cmd, args, cwd) {
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

function defaultWriteProof({ repoRoot: targetRoot, proof, markdown }) {
  const docsDir = join(targetRoot, 'docs')
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(
    join(docsDir, 'orchestration-proof.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(docsDir, 'orchestration-proof.md'),
    markdown,
    'utf8',
  )
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

export function buildStage1Prompt({ specPath, specText, workCwd, fromScratch }) {
  if (fromScratch) {
    return [
      `Read ONLY "scripts/io-contract.mjs" to check the required JSON schema (including sceneRole). Do NOT read, glob, or grep any other files.`,
      `Use the write tool to create "${join(workCwd, 'openplc', 'io-contract.json')}" from scratch with valid JSON for all 11 signals (Start_PB %IX0.0 start_pb.tag, Stop_PB %IX0.1 stop_pb.tag, EStop %IX0.2 estop_pb.tag with contact: "NC", TRUE = released/healthy, FALSE = struck/tripped, Reset_Count_PB %IX0.3 reset_pb.tag, PhotoEye %IX0.4 photoeye_1.tag, Conveyor_Run %QX0.0 belt_1.runTag, Spawner_Enable %QX0.1 spawner_1.runTag, Run_Light %QX0.2 start_pb.lampTag, Dwell_Light %QX0.3 stop_pb.lampTag, Fault_Light %QX0.4 estop_pb.lampTag, Box_Count %QW0 batch_indicator.tag), parameters (scanIntervalMs:20, inspectionDwellMs:2000, batchTarget:5, spawnPulseMs:500, spawnCooldownMs:5000, jamTimeoutMs:4000), and Modbus settings (host.docker.internal:5020, slaveId:1, cycleTimeMs:50).`,
      `Then immediately reply with a concise 3-bullet dispatch brief (one bullet each for plc-coder, oip-builder, and test-engineer).`,
      '',
      specText,
    ].join('\n')
  }
  return [
    `Read ${specPath} and openplc/io-contract.json.`,
    `Confirm that all signals in openplc/io-contract.json cover the plain-English specification below and emit a 3-bullet dispatch brief (one bullet each for plc-coder, oip-builder, and test-engineer). Do not edit files.`,
    '',
    specText,
  ].join('\n')
}

export function buildGreenfieldWorkerPrompt({ workerSpec, orchestratorBrief, repoRoot }) {
  const linkHint = `Local toolchains live at "${repoRoot}/.tools" and "${repoRoot}/Open-Industry-Project". If needed to run local validators inside your worktree, symlink them first (they are gitignored).`

  if (workerSpec.agent === 'plc-coder') {
    return [
      `Orchestrator dispatch brief:\n${orchestratorBrief}`,
      '',
      `1. Call the skill tool to load "openplc-st" and also read ".opencode/skills/openplc-st/strucpp-modbus-reference.md".`,
      `2. Read openplc/io-contract.json, docs/cell-process-spec.md, GLOSSARY.md, and scripts/io-contract.mjs.`,
      `3. Author from scratch:`,
      `   - openplc/conveyor_cell.st (FUNCTION_BLOCK ConveyorCellController with exact VAR_INPUT/VAR_OUTPUT names from openplc/io-contract.json and VAR CONSTANT matching parameters: BATCH_TARGET:=5, DWELL_TIME:=T#2s, JAM_THRESHOLD_TIME:=T#4s, SPAWN_PULSE_TIME:=T#500ms, SPAWN_COOLDOWN_TIME:=T#5s + PROGRAM ConveyorCellMain with located AT variables in their own VAR block and fail-safe NC boundary inversion EStop := NOT EStop when instantiating ConveyorCellController because EStop %IX0.2 is NC TRUE=released/FALSE=struck while ConveyorCellController uses active-high EStop + CONFIGURATION Config0 with INTERVAL := T#20ms task)`,
      `   - openplc/conveyor_cell_modbus_master.json (derive directly from openplc/io-contract.json via scripts/io-contract.mjs deriveModbusMaster)`,
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
      `3. ${linkHint} Write scenes/conveyor-cell/scene.json (OIP format version 4) with the 9 parts matching every sceneRole in openplc/io-contract.json and the top-level "plcs" entry:`,
      `   - belt_1: packageId "oip.belt-conveyor", position [0.085,0.8,0], rotationY 0, params { fpmUnits:false, segments:[[5,0]], width:0.8, standHeight:0.8, speed:0.5, runTag:"%QX0.0" }`,
      `   - spawner_1: packageId "oip.box-spawner", position [0.35,1.25,0], rotationY 0, params { boxesPerMinute:12, length:0.4, keepSpacing:true, runTag:"%QX0.1", conveyorId:"belt_1", release:"enable" }`,
      `   - photoeye_1: packageId "oip.diffuse-sensor", position [2,0.78,0.457], rotationY 3.141593, params { tag:"%IX0.4", maxRange:0.84 }`,
      `   - start_pb: packageId "oip.push-button", parent "belt_1", position [0.5,0.8,-0.43], rotationY 3.141593, params { text:"START", buttonColor:"#16a34a", lampSource:"tag", tag:"%IX0.0", lampTag:"%QX0.2" }`,
      `   - stop_pb: packageId "oip.push-button", parent "belt_1", position [0.9,0.8,-0.43], rotationY 3.141593, params { buttonColor:"#d97706", lampSource:"tag", tag:"%IX0.1", lampTag:"%QX0.3" }`,
      `   - estop_pb: packageId "oip.push-button", parent "belt_1", position [1.3,0.8,-0.43], rotationY 3.141593, params { emergencyStop:true, text:"E-STOP", buttonColor:"#dc2626", momentary:false, lampSource:"tag", tag:"%IX0.2", lampTag:"%QX0.4" }`,
      `   - reset_pb: packageId "oip.push-button", parent "belt_1", position [1.7,0.8,-0.43], rotationY 3.141593, params { text:"RESET", buttonColor:"#2563eb", tag:"%IX0.3" }`,
      `   - despawner_1: packageId "oip.despawner", position [6.17,0,0], rotationY 0, params { length:1.2, width:1.2, countTag:"" }`,
      `   - batch_indicator: packageId "oip.stack-light", position [2.1,0,-0.6], rotationY 0, params { tag:"%QW0" }`,
      `   - Top-level "plcs": [{ "name": "PLC1", "runsOn": "plc", "protocol": "serve", "connect": true }]`,
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
  repoRoot = REPO_ROOT,
  runAgent = runOpenCodeAgent,
  probeModels = probeModelPair,
  resolveModels = () => resolveDefaultModels({ cwd: repoRoot }),
  workspace = createGitWorktreeWorkspace(repoRoot),
  runGate = defaultRunGate,
  writeProof = defaultWriteProof,
  log = console.log,
} = {}) {
  let resolvedOrchestratorModel = orchestratorModel
  let resolvedWorkerModel = workerModel
  let fallbackUsed = false

  let machine = createInitialState({ maxPostMergeRepairs: 1 })
  machine = stepMachine(machine, { type: 'START_PREFLIGHT' })

  if (usePreflight) {
    const probed = await probeModels()
    if (!probed.ok) {
      machine = stepMachine(machine, { type: 'PREFLIGHT_FAILED', reason: 'No live-callable model pair available.' })
      throw new Error(`Model preflight failed: ${JSON.stringify(probed.attempts)}`)
    }
    resolvedOrchestratorModel = orchestratorModel ?? probed.orchestratorModel
    resolvedWorkerModel = workerModel ?? probed.workerModel
    fallbackUsed = probed.fallbackUsed
  }

  if (!resolvedOrchestratorModel || !resolvedWorkerModel) {
    const defaults = resolveModels()
    resolvedOrchestratorModel = resolvedOrchestratorModel ?? defaults.orchestrator
    resolvedWorkerModel = resolvedWorkerModel ?? defaults.worker
  }

  machine = stepMachine(machine, {
    type: 'PREFLIGHT_RESOLVED',
    orchestratorModel: resolvedOrchestratorModel,
    workerModel: resolvedWorkerModel,
    fallbackUsed,
  })
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const specText = readFileSync(resolve(repoRoot, specPath), 'utf8')

  const greenfieldBase = fromScratch
    ? workspace.prepareGreenfieldBase({ runId, stripFiles: GREENFIELD_FILES })
    : null
  const workCwd = greenfieldBase ? greenfieldBase.baseWorktreePath : repoRoot

  let orchestrator
  let contract
  let workerResults
  let merge
  let verification
  let repairPass = null
  const preStage2Worktrees = workspace.listWorktreePaths()

  const cleanupNewWorktrees = () => {
    const current = workspace.listWorktreePaths()
    const created = [...current].filter(
      (p) => !preStage2Worktrees.has(p) && (!greenfieldBase || p !== greenfieldBase.baseWorktreePath),
    )
    if (created.length > 0) workspace.removeWorktrees(created)
  }

  try {
    log(
      `[orchestrate:${runId}] Stage 1: Orchestrator (${resolvedOrchestratorModel}) ${fromScratch ? 'synthesizing canonical I/O Contract from scratch' : 'reviewing spec & I/O Contract'}...`,
    )
    try {
      const stage1Prompt = buildStage1Prompt({ specPath, specText, workCwd, fromScratch })

      orchestrator = await runAgent({
        agent: 'orchestrator',
        model: resolvedOrchestratorModel,
        prompt: stage1Prompt,
        cwd: workCwd,
        timeoutMs: 360000,
      })

      if (greenfieldBase) {
        const synthesizedContractPath = join(workCwd, 'openplc', 'io-contract.json')
        if (!existsSync(synthesizedContractPath)) {
          throw new Error(
            `Orchestrator did not write ${synthesizedContractPath} (tools=${JSON.stringify(orchestrator.toolsUsed)}): ${(orchestrator.finalText ?? '').slice(0, 300)}`,
          )
        }
        workspace.commitPath({
          cwd: workCwd,
          pathSpec: 'openplc/io-contract.json',
          message: 'feat: orchestrator synthesized canonical I/O Contract',
        })
      }

      contract = JSON.parse(readFileSync(join(workCwd, 'openplc', 'io-contract.json'), 'utf8'))
    } catch (err) {
      machine = stepMachine(machine, {
        type: 'ORCHESTRATOR_FAILED',
        reason: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    machine = stepMachine(machine, { type: 'ORCHESTRATOR_DONE' })

    log(
      `[orchestrate:${runId}] Stage 2: Dispatching 3 parallel workers (${resolvedWorkerModel}) in isolated git worktrees...`,
    )
    const workerSettled = await Promise.allSettled(
      WORKER_SPECS.map(async (workerSpec) => {
        const res = await runAgent({
          agent: workerSpec.agent,
          model: resolvedWorkerModel,
          worktreeName: `${runId}-${workerSpec.agent}`,
          cwd: workCwd,
          timeoutMs: fromScratch ? 360000 : 240000,
          prompt: fromScratch
            ? buildGreenfieldWorkerPrompt({
                workerSpec,
                orchestratorBrief: orchestrator.finalText,
                repoRoot,
              })
            : [
                `Orchestrator dispatch brief:\n${orchestrator.finalText}`,
                '',
                `Call the skill tool to load "${workerSpec.expectedSkill}".`,
                `Verify your owned files (${workerSpec.ownedFiles.join(', ')}) against openplc/io-contract.json and write "worktree-manifest-${workerSpec.agent}.json" at the repo root with {"agent":"${workerSpec.agent}","skill":"${workerSpec.expectedSkill}","signalsVerified":${contract.signals.length},"ownedFiles":${JSON.stringify(workerSpec.ownedFiles)},"status":"verified"}.`,
                `Reply with one concise sentence confirming the skill loaded and manifest written.`,
              ].join('\n'),
        })
        return { ...res, expectedSkill: workerSpec.expectedSkill }
      }),
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

    log(`[orchestrate:${runId}] Stage 3: Merging 3 worker worktree branches into integration branch...`)
    const baseRef = greenfieldBase ? greenfieldBase.baseBranch : 'HEAD'
    try {
      merge = workspace.mergeWorkerBranches({
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

    workspace.linkLocalToolchains(merge.integrationWorktreePath)

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

    log(`[orchestrate:${runId}] Stage 4: Running verification gates on merged integration worktree...`)
    verification = runAllGates()

    while (!allGatesPassed(verification)) {
      machine = stepMachine(machine, {
        type: 'GATE_FAIL_REPAIR',
        gates: {
          contractTest: verification.contractTest.passed ? 'pass' : 'fail',
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

      log(
        `[orchestrate:${runId}] Stage 4 Repair Pass ${machine.repairAttempts}/${machine.maxPostMergeRepairs}: Orchestrator patching integration worktree...\n${failureSummary}`,
      )

      repairPass = await runAgent({
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

  await writeProof({
    repoRoot,
    proof,
    markdown: renderProofMarkdown(proof),
  })

  log(`[orchestrate:${runId}] Complete! Proof written to docs/orchestration-proof.{json,md}`)
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
