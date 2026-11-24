#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  createGitWorktreeWorkspace,
  mergeWorkerBranches,
  prepareGreenfieldBase,
} from './git-worktree-workspace.mjs'
import { deriveModbusMaster, validateContractSchema } from './io-contract.mjs'
import { formatCatalogSummary, loadOipCatalog } from './oip-catalog.mjs'
import {
  inspectNdjsonRetryLine,
  parseOpenCodeNdjson,
  probeModelPair,
  resolveDefaultModels,
  runOpenCodeAgent,
} from './opencode-runner.mjs'
import { createInitialState, transition } from './orchestration-machine.mjs'
import { runCell } from './run-cell.mjs'
import { verifyCell } from './verify-cell.mjs'

export {
  inspectNdjsonRetryLine,
  mergeWorkerBranches,
  parseOpenCodeNdjson,
  prepareGreenfieldBase,
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SLUG_RX = /^[a-z0-9][a-z0-9_-]*$/

export function slugifyPrompt(text) {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!cleaned) return 'generated-cell'
  const words = cleaned.split('-').filter(Boolean).slice(0, 5)
  const slug = words.join('-').slice(0, 36).replace(/-+$/g, '')
  return slug || 'generated-cell'
}

export function buildWorkerSpecs(slug) {
  return [
    {
      agent: 'plc-coder',
      expectedSkill: 'openplc-st',
      ownedFiles: [`scenes/${slug}/plc/program.st`],
    },
    {
      agent: 'oip-builder',
      expectedSkill: 'oip-scene',
      ownedFiles: [
        `scenes/${slug}/project.json`,
        `scenes/${slug}/scene.json`,
        `scenes/${slug}/parts`,
      ],
    },
    {
      agent: 'test-engineer',
      expectedSkill: 'plc-oip-verify',
      ownedFiles: [`scenes/${slug}/tests/program.test.st`],
    },
  ]
}

export function buildStage1Prompt({ slug, promptText, workCwd, catalogSummary }) {
  const contractPath = join(workCwd, 'scenes', slug, 'io-contract.json')
  const specPath = join(workCwd, 'scenes', slug, 'process-spec.md')
  return [
    `Read ONLY "GLOSSARY.md". Do NOT browse, glob, or grep inside "Open-Industry-Project/".`,
    `You are designing a brand-new OIP + OpenPLC Cell named "${slug}" from the user's plain-English description below.`,
    '',
    `Available OIP Part Catalog (use ONLY these packageIds and their listed signal names/directions/types):`,
    catalogSummary,
    '',
    `If the user requests hardware that cannot be simulated with the OIP catalog above, do NOT write any files — immediately reply starting with "UNSUPPORTED_HARDWARE:" explaining what is missing.`,
    '',
    `Otherwise, infer sensible industrial defaults for any unspecified parameters (such as safe start-stopped latch, 20ms scan cycle, NC E-Stop polarity if an E-Stop is included) and write TWO files:`,
    `1. "${contractPath}" — valid JSON with:`,
    `   - "name": "${slug}", "version": "1.0.0"`,
    `   - "plc": { "functionBlockName": "<ValidIecIdent>", "programName": "<ValidIecIdent>" } (distinct identifiers)`,
    `   - "modbus": { "topology": "oip-server-openplc-master", "oipHostForPlc": "host.docker.internal", "port": 5020, "slaveId": 1, "cycleTimeMs": 50 }`,
    `   - "parameters": { "scanIntervalMs": 20, ...optional tuning parameters }`,
    `   - "signals": non-empty array where each signal has { name, iecAddress (%IXn.b|%IWn|%QXn.b|%QWn), type (BOOL for %IX/%QX; INT/WORD/DINT for %IW/%QW), direction ("oip_to_plc" for %I* / OIP dir:"out", "plc_to_oip" for %Q* / OIP dir:"in"), modbusArea ("discreteInput"|"inputRegister"|"coil"|"holdingRegister"), modbusAddress (byte*8+bit or word index), optional contact: "NC" for emergencyStop push buttons, sceneRole: { partId, param, packageId }, description }.`,
    `2. "${specPath}" — concise Markdown documenting the process behavior, parts, signals, and every inferred default.`,
    '',
    `Then immediately reply with a concise 3-bullet dispatch brief (one bullet each for plc-coder, oip-builder, and test-engineer).`,
    '',
    `User Plain-English Description:`,
    promptText,
  ].join('\n')
}

export function buildWorkerPrompt({ slug, workerSpec, orchestratorBrief, repoRoot }) {
  const linkHint = `Local toolchains live at "${repoRoot}/.tools" and "${repoRoot}/Open-Industry-Project". If needed to run local validators inside your worktree, symlink them first (they are gitignored).`

  if (workerSpec.agent === 'plc-coder') {
    return [
      `Orchestrator dispatch brief:\n${orchestratorBrief}`,
      '',
      `1. Call the skill tool to load "openplc-st".`,
      `2. Read "scenes/${slug}/io-contract.json", "scenes/${slug}/process-spec.md", and "GLOSSARY.md".`,
      `3. Author "scenes/${slug}/plc/program.st" matching the frozen plc.functionBlockName, plc.programName, all located AT signals (in their own dedicated VAR block), NC boundary inversion for any contact:"NC" signal, and TASK INTERVAL matching parameters.scanIntervalMs.`,
      `4. Self-heal (max 2 attempts): ${linkHint} Compile "scenes/${slug}/plc/program.st" with ".tools/strucpp/strucpp/strucpp scenes/${slug}/plc/program.st --debug -o /tmp/check_${slug}.cpp" and fix any errors.`,
      `5. Only modify "scenes/${slug}/plc/program.st". Reply with one concise summary sentence.`,
    ].join('\n')
  }

  if (workerSpec.agent === 'oip-builder') {
    return [
      `Orchestrator dispatch brief:\n${orchestratorBrief}`,
      '',
      `1. Call the skill tool to load "oip-scene" and read ".opencode/skills/oip-scene/oip-cli-reference.md".`,
      `2. Read "scenes/${slug}/io-contract.json" and "scenes/${slug}/process-spec.md". Use OIP CLI directly without grepping "Open-Industry-Project/" source files.`,
      `3. ${linkHint} Build "scenes/${slug}/" (project.json, scene.json version 4, and baked parts/) via "npm --prefix Open-Industry-Project run add-part / snap-part / edit-part" against "$PWD/scenes/${slug}". Wire every signal in io-contract.json to its exact sceneRole.partId and sceneRole.param, include top-level "plcs": [{ "name": "PLC1", "runsOn": "plc", "protocol": "serve", "connect": true }] in scene.json, and ensure project.json lists "program": ["plc/program.st"].`,
      `4. Self-heal (max 2 attempts): Run validate-project --strict, check-wiring --strict, and check-layout against "$PWD/scenes/${slug}" and fix any errors.`,
      `5. Only modify files under "scenes/${slug}/" (project.json, scene.json, parts/). Leave plc/ and tests/ untouched. Reply with one concise summary sentence.`,
    ].join('\n')
  }

  return [
    `Orchestrator dispatch brief:\n${orchestratorBrief}`,
    '',
    `1. Call the skill tool to load "plc-oip-verify" and read ".opencode/skills/plc-oip-verify/verification-seams.md".`,
    `2. Read "scenes/${slug}/io-contract.json", "scenes/${slug}/process-spec.md", and "GLOSSARY.md".`,
    `3. Author "scenes/${slug}/tests/program.test.st" testing FUNCTION_BLOCK <plc.functionBlockName> across every core process behavior in process-spec.md using exact signal names from io-contract.json, single-quoted TEST '...' titles, top-level ADVANCE_TIME(<ns>); only, and SETUP instantiating the function block.`,
    `4. Only modify "scenes/${slug}/tests/program.test.st". Reply with one concise summary sentence.`,
  ].join('\n')
}

export function renderGenerationReport(report) {
  const agents = [report.orchestrator]
  if (report.stage1Repair) agents.push({ ...report.stage1Repair, agent: 'orchestrator (stage1-repair)' })
  if (Array.isArray(report.workers)) agents.push(...report.workers)
  if (report.repairPass) agents.push({ ...report.repairPass, agent: 'orchestrator (stage4-repair)' })

  const totalCost = agents.reduce((acc, a) => acc + (a.costUsd ?? 0), 0)
  const rows = agents.map((entry) => {
    const skills = (entry.skillsLoaded ?? []).length > 0 ? entry.skillsLoaded.join(', ') : '(coordinator)'
    const worktree = entry.worktreePath ? `\`${entry.worktreePath}\`` : 'base/integration worktree'
    const tools =
      Object.entries(entry.toolsUsed ?? {})
        .map(([k, v]) => `${k}:${v}`)
        .join(', ') || 'none'
    return `| \`${entry.agent}\` | \`${entry.model}\` | ${skills} | ${tools} | ${worktree} | ${((entry.durationMs ?? 0) / 1000).toFixed(1)}s | ${entry.tokens?.input ?? 0} in / ${entry.tokens?.reasoning ?? 0} think / ${entry.tokens?.output ?? 0} out | \$${(entry.costUsd ?? 0).toFixed(5)} |`
  })

  const lines = [
    `# Cell Generation Report: \`${report.slug}\``,
    '',
    `- **Run ID:** \`${report.runId}\``,
    `- **Mode:** \`${report.mode}\``,
    `- **Captured At:** \`${report.capturedAt}\``,
    `- **Output Directory:** \`scenes/${report.slug}/\``,
    `- **Total Estimated Cost:** \`\$${totalCost.toFixed(5)}\``,
    `- **Stage 1 Repair Passes:** \`${report.stage1Repair ? 1 : 0}\``,
    `- **Stage 4 Repair Passes:** \`${report.repairAttempts ?? 0}\``,
    '',
    '## Tiered Model, Skill Scoping, Tool Calls & Cost Breakdown',
    '',
    '| Agent | Model | Skills Loaded | Tools Used | Worktree | Wall Time | Tokens | Cost (USD) |',
    '| :--- | :--- | :--- | :--- | :--- | ---: | :--- | ---: |',
    ...rows,
    '',
  ]

  if (report.merge?.mergedBranches?.length) {
    lines.push(
      '## Isolated Worktree Branches Merged',
      '',
      '| Worker | Worktree Branch | Worker Commit | Merge Commit | Files Changed |',
      '| :--- | :--- | :--- | :--- | :--- |',
      ...report.merge.mergedBranches.map(
        (b) =>
          `| \`${b.worker}\` | \`${b.branch}\` | \`${b.commitSha}\` | \`${b.mergeSha ?? '-'}\` | ${(b.filesChanged ?? []).map((f) => `\`${f}\``).join(', ') || '(none)'} |`,
      ),
      '',
    )
  }

  if (report.verification) {
    const g = report.verification.gates
    lines.push(
      '## Generic Post-Merge Verification Gates',
      '',
      `- **Gate 1 — I/O Contract Conformance:** ${g.contract?.passed ? 'PASS' : 'FAIL'}`,
      `- **Gate 2 — STruC++ PLC Unit Tests:** ${g.plcTest?.passed ? 'PASS' : 'FAIL'}`,
      `- **Gate 3 — OIP Validators (strict project/ST/wiring + error-only layout):** ${g.oipValidate?.passed ? 'PASS' : 'FAIL'}`,
      '',
    )
    if (report.verification.warnings?.length > 0) {
      lines.push(
        '### Non-Fatal Layout Warnings',
        '',
        ...report.verification.warnings.map((w) => `- ${w}`),
        '',
      )
    }
  }

  lines.push(
    '## Next Steps',
    '',
    `- Re-verify offline: \`npm run cell:verify -- ${report.slug}\``,
    `- Deploy to OpenPLC & open in OIP Desktop: \`npm run cell:run -- ${report.slug}\``,
    '',
  )
  return lines.join('\n')
}

function stepMachine(machine, event) {
  const next = transition(machine, event)
  if (next.lastRejected) {
    throw new Error(`Orchestration state machine rejected ${event.type}: ${next.lastMessage}`)
  }
  return next
}

function writeDeterministicModbus(cellDir, contract) {
  const plcDir = join(cellDir, 'plc')
  mkdirSync(plcDir, { recursive: true })
  const modbusMaster = deriveModbusMaster(contract)
  writeFileSync(join(plcDir, 'modbus_master.json'), `${JSON.stringify(modbusMaster, null, 2)}\n`, 'utf8')
}

function persistCellDirectory({ sourceCellDir, targetCellDir, force }) {
  if (existsSync(targetCellDir)) {
    if (!force) {
      throw new Error(`Cell "${targetCellDir}" already exists. Pass --force to overwrite.`)
    }
    rmSync(targetCellDir, { recursive: true, force: true })
  }
  mkdirSync(dirname(targetCellDir), { recursive: true })
  cpSync(sourceCellDir, targetCellDir, { recursive: true })
}

function computeTotals(agents) {
  return agents.reduce(
    (acc, a) => {
      acc.durationMs += a?.durationMs ?? 0
      acc.costUsd += a?.costUsd ?? 0
      acc.tokens.input += a?.tokens?.input ?? 0
      acc.tokens.output += a?.tokens?.output ?? 0
      acc.tokens.reasoning += a?.tokens?.reasoning ?? 0
      return acc
    },
    { durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, reasoning: 0 } },
  )
}

function writeCellReport(targetCellDir, report) {
  writeFileSync(
    join(targetCellDir, 'generation-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(targetCellDir, 'generation-report.md'), renderGenerationReport(report), 'utf8')
}

export async function generateCell({
  prompt,
  specPath,
  name,
  orchestratorModel,
  workerModel,
  usePreflight = false,
  stage1Only = false,
  deploy = false,
  open = false,
  verifyLive = false,
  force = false,
  repoRoot = REPO_ROOT,
  onEvent = () => {},
  runAgent = runOpenCodeAgent,
  probeModels = probeModelPair,
  resolveModels = () => resolveDefaultModels({ cwd: repoRoot }),
  loadCatalog = () => loadOipCatalog({ repoRoot }),
  workspace = createGitWorktreeWorkspace(repoRoot),
  verifyCellFn = verifyCell,
  runCellFn = runCell,
  log = console.log,
} = {}) {
  const promptText = prompt?.trim()
    ? prompt.trim()
    : specPath
      ? readFileSync(resolve(repoRoot, specPath), 'utf8').trim()
      : ''

  if (!promptText) {
    throw new Error('Provide a plain-English Cell description via --prompt or --spec.')
  }

  const slug = (name?.trim() || slugifyPrompt(promptText)).toLowerCase()
  if (!SLUG_RX.test(slug)) {
    throw new Error(`Invalid Cell slug "${slug}". Use lowercase letters, digits, hyphens, or underscores.`)
  }
  if (slug === 'conveyor-cell') {
    throw new Error('Refusing to overwrite protected Task 1 reference Cell "conveyor-cell". Choose a different --name.')
  }
  const targetCellDir = join(repoRoot, 'scenes', slug)
  if (existsSync(targetCellDir) && !force) {
    throw new Error(`Cell "scenes/${slug}" already exists. Pass --force to overwrite or pick a new --name.`)
  }

  let resolvedOrchestratorModel = orchestratorModel
  let resolvedWorkerModel = workerModel
  let fallbackUsed = false

  let machine = createInitialState({ maxPostMergeRepairs: 1 })
  machine = stepMachine(machine, { type: 'START_PREFLIGHT' })
  onEvent({ stage: 'preflight', slug })

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
  const catalog = loadCatalog()
  const catalogSummary = formatCatalogSummary(catalog)
  const workerSpecs = buildWorkerSpecs(slug)
  const greenfieldBase = workspace.prepareGreenfieldBase({ runId, stripFiles: [`scenes/${slug}`] })
  const workCwd = greenfieldBase.baseWorktreePath
  const baseCellDir = join(workCwd, 'scenes', slug)
  const preStage2Worktrees = workspace.listWorktreePaths()

  let orchestrator
  let stage1Repair = null
  let contract
  let workerResults = []
  let merge = null
  let verification = null
  let repairPass = null

  const cleanupNewWorktrees = () => {
    const current = workspace.listWorktreePaths()
    const created = [...current].filter(
      (p) => !preStage2Worktrees.has(p) && p !== greenfieldBase.baseWorktreePath,
    )
    if (created.length > 0) workspace.removeWorktrees(created)
  }

  try {
    // Stage 1: Synthesize canonical I/O Contract + process spec + deterministic Modbus master
    onEvent({ stage: 'stage1', slug, model: resolvedOrchestratorModel })
    log(`[generate:${runId}] Stage 1: Orchestrator (${resolvedOrchestratorModel}) designing Cell "${slug}"...`)

    try {
      const stage1Prompt = buildStage1Prompt({ slug, promptText, workCwd, catalogSummary })
      orchestrator = await runAgent({
        agent: 'orchestrator',
        model: resolvedOrchestratorModel,
        prompt: stage1Prompt,
        cwd: workCwd,
        timeoutMs: 360000,
      })

      const contractPath = join(baseCellDir, 'io-contract.json')
      if (!existsSync(contractPath)) {
        const reply = (orchestrator.finalText ?? '').trim()
        if (reply.includes('UNSUPPORTED_HARDWARE')) {
          throw new Error(reply)
        }
        throw new Error(
          `Orchestrator did not write ${contractPath} (tools=${JSON.stringify(orchestrator.toolsUsed)}): ${reply.slice(0, 300)}`,
        )
      }

      const loadAndValidateContract = () => {
        let parsed
        try {
          parsed = JSON.parse(readFileSync(contractPath, 'utf8'))
        } catch (parseErr) {
          return {
            parsed: null,
            validation: {
              ok: false,
              problems: [
                {
                  artifact: 'io-contract.json',
                  message: `Invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                },
              ],
            },
          }
        }
        const validation = validateContractSchema(parsed, { catalog, requirePlc: true })
        return { parsed, validation }
      }

      let { parsed, validation } = loadAndValidateContract()
      if (!validation.ok) {
        const summary = validation.problems.map((p) => `- ${p.message}`).join('\n')
        log(`[generate:${runId}] Stage 1 validation failed (${validation.problems.length} issue(s)); running 1 fast repair pass...`)
        stage1Repair = await runAgent({
          agent: 'orchestrator',
          model: resolvedOrchestratorModel,
          cwd: workCwd,
          timeoutMs: 240000,
          prompt: [
            `Stage 1 I/O Contract validation failed on "${contractPath}". Fix ONLY the issues listed below against the OIP catalog and rewrite "${contractPath}".`,
            '',
            summary,
            '',
            `OIP Part Catalog:`,
            catalogSummary,
          ].join('\n'),
        })
        ;({ parsed, validation } = loadAndValidateContract())
        if (!validation.ok) {
          throw new Error(
            `Stage 1 I/O Contract still invalid after repair:\n${validation.problems.map((p) => `- ${p.message}`).join('\n')}`,
          )
        }
      }

      contract = parsed
      if (!existsSync(join(baseCellDir, 'process-spec.md'))) {
        writeFileSync(join(baseCellDir, 'process-spec.md'), `# ${slug}\n\n${promptText}\n`, 'utf8')
      }
      writeDeterministicModbus(baseCellDir, contract)

      workspace.commitPath({
        cwd: workCwd,
        pathSpec: [
          `scenes/${slug}/io-contract.json`,
          `scenes/${slug}/process-spec.md`,
          `scenes/${slug}/plc/modbus_master.json`,
        ],
        message: `feat(${slug}): stage 1 frozen I/O Contract and deterministic Modbus master`,
      })
    } catch (err) {
      machine = stepMachine(machine, {
        type: 'ORCHESTRATOR_FAILED',
        reason: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    if (stage1Only) {
      persistCellDirectory({ sourceCellDir: baseCellDir, targetCellDir, force })
      const stage1Agents = [orchestrator, ...(stage1Repair ? [stage1Repair] : [])]
      const report = {
        ok: true,
        runId,
        slug,
        mode: 'stage1-only',
        capturedAt: new Date().toISOString(),
        outputDir: targetCellDir,
        totals: computeTotals(stage1Agents),
        orchestrator,
        ...(stage1Repair ? { stage1Repair } : {}),
        workers: [],
        repairAttempts: 0,
      }
      writeCellReport(targetCellDir, report)
      onEvent({ stage: 'done', slug, mode: 'stage1-only', outputDir: targetCellDir })
      log(`[generate:${runId}] Stage 1 complete! Persisted contract & Modbus master to scenes/${slug}/`)
      return report
    }

    machine = stepMachine(machine, { type: 'ORCHESTRATOR_DONE' })

    // Stage 2: 3 parallel workers in isolated git worktrees
    onEvent({ stage: 'stage2', slug, model: resolvedWorkerModel })
    log(`[generate:${runId}] Stage 2: Dispatching 3 parallel workers (${resolvedWorkerModel}) in isolated git worktrees...`)
    const workerSettled = await Promise.allSettled(
      workerSpecs.map(async (workerSpec) => {
        const res = await runAgent({
          agent: workerSpec.agent,
          model: resolvedWorkerModel,
          worktreeName: `${runId}-${workerSpec.agent}`,
          cwd: workCwd,
          timeoutMs: 360000,
          prompt: buildWorkerPrompt({
            slug,
            workerSpec,
            orchestratorBrief: orchestrator.finalText,
            repoRoot,
          }),
        })
        return { ...res, expectedSkill: workerSpec.expectedSkill }
      }),
    )

    const failedIdx = workerSettled.findIndex((r) => r.status === 'rejected')
    if (failedIdx >= 0) {
      cleanupNewWorktrees()
      machine = stepMachine(machine, {
        type: 'WORKER_API_ABORT',
        worker: workerSpecs[failedIdx].agent,
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

    // Stage 3: Merge worker branches cleanly into integration worktree
    onEvent({ stage: 'stage3', slug })
    log(`[generate:${runId}] Stage 3: Merging 3 worker worktree branches...`)
    try {
      merge = workspace.mergeWorkerBranches({
        runId,
        baseRef: greenfieldBase.baseBranch,
        workers: workerResults.map((w) => ({
          name: w.agent,
          worktreePath: w.worktreePath,
          ownedFiles: workerSpecs.find((s) => s.agent === w.agent)?.ownedFiles,
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

    // Ensure Stage 1 artifacts exist in integration worktree (in case workspace stub didn't copy base)
    const intCellDir = join(merge.integrationWorktreePath, 'scenes', slug)
    if (!existsSync(join(intCellDir, 'io-contract.json'))) {
      mkdirSync(join(intCellDir, 'plc'), { recursive: true })
      cpSync(join(baseCellDir, 'io-contract.json'), join(intCellDir, 'io-contract.json'))
      cpSync(join(baseCellDir, 'process-spec.md'), join(intCellDir, 'process-spec.md'))
      cpSync(join(baseCellDir, 'plc', 'modbus_master.json'), join(intCellDir, 'plc', 'modbus_master.json'))
    }

    // Stage 4: Generic 3-gate offline verification + max 1 repair pass
    onEvent({ stage: 'stage4', slug })
    log(`[generate:${runId}] Stage 4: Running generic 3-gate verifier (cell:verify) for "${slug}"...`)
    verification = verifyCellFn({ slug, repoRoot: merge.integrationWorktreePath, log: () => {}, error: () => {} })

    while (!verification.ok) {
      machine = stepMachine(machine, {
        type: 'GATE_FAIL_REPAIR',
        gates: {
          contractTest: verification.gates.contract?.passed ? 'pass' : 'fail',
          plcTest: verification.gates.plcTest?.passed ? 'pass' : 'fail',
          oipValidate: verification.gates.oipValidate?.passed ? 'pass' : 'fail',
          e2eModbus: 'pass',
        },
      })
      if (machine.phase === 'failed') {
        throw new Error(
          `Verification failed after repair budget exhausted: contract=${verification.gates.contract?.passed}, plcTest=${verification.gates.plcTest?.passed}, oipValidate=${verification.gates.oipValidate?.passed}`,
        )
      }

      const failureSummary = [
        `Gate 1 — I/O Contract (${verification.gates.contract?.passed ? 'PASS' : 'FAIL'}): ${JSON.stringify(verification.gates.contract?.problems ?? [])}`,
        `Gate 2 — STruC++ PLC Unit Tests (${verification.gates.plcTest?.passed ? 'PASS' : 'FAIL'}):\n${verification.gates.plcTest?.summary ?? ''}`,
        `Gate 3 — OIP Validators (${verification.gates.oipValidate?.passed ? 'PASS' : 'FAIL'}):\n${verification.gates.oipValidate?.summary ?? ''}`,
      ].join('\n\n')

      onEvent({ stage: 'stage4_repair', slug, attempt: machine.repairAttempts })
      log(`[generate:${runId}] Stage 4 Repair Pass ${machine.repairAttempts}/${machine.maxPostMergeRepairs}...`)
      repairPass = await runAgent({
        agent: 'orchestrator',
        model: resolvedOrchestratorModel,
        cwd: merge.integrationWorktreePath,
        timeoutMs: 420000,
        prompt: [
          `Post-merge verification failed for Cell "scenes/${slug}/". Fix ONLY the failing files under "scenes/${slug}/" so "npm run cell:verify -- ${slug}" passes.`,
          `Read only the failing files reported below and apply minimal targeted fixes. Do NOT browse "Open-Industry-Project/" source files.`,
          '',
          failureSummary,
        ].join('\n'),
      })

      // Re-derive deterministic modbus_master.json in case io-contract.json was repaired
      const updatedContract = JSON.parse(readFileSync(join(intCellDir, 'io-contract.json'), 'utf8'))
      writeDeterministicModbus(intCellDir, updatedContract)

      machine = stepMachine(machine, { type: 'REPAIR_PATCH_APPLIED' })
      verification = verifyCellFn({ slug, repoRoot: merge.integrationWorktreePath, log: () => {}, error: () => {} })
    }

    machine = stepMachine(machine, { type: 'GATES_ALL_PASS' })
    persistCellDirectory({ sourceCellDir: intCellDir, targetCellDir, force })
  } finally {
    if (merge) merge.cleanup()
    cleanupNewWorktrees()
    greenfieldBase.cleanup()
  }

  const latestStart = Math.max(...workerResults.map((w) => Date.parse(w.startedAt)))
  const earliestEnd = Math.min(...workerResults.map((w) => Date.parse(w.finishedAt)))
  const parallelOverlapMs = Math.max(0, earliestEnd - latestStart)

  const allAgents = [
    orchestrator,
    ...(stage1Repair ? [stage1Repair] : []),
    ...workerResults,
    ...(repairPass ? [repairPass] : []),
  ]

  const report = {
    ok: true,
    runId,
    slug,
    mode: 'generate',
    capturedAt: new Date().toISOString(),
    outputDir: targetCellDir,
    parallelOverlapMs,
    repairAttempts: machine.repairAttempts,
    totals: computeTotals(allAgents),
    orchestrator,
    ...(stage1Repair ? { stage1Repair } : {}),
    workers: workerResults,
    ...(repairPass ? { repairPass } : {}),
    merge: {
      integrationBranch: merge.integrationBranch,
      conflicts: merge.conflicts,
      mergedBranches: merge.mergedBranches,
    },
    verification,
  }

  if (deploy || open || verifyLive) {
    const deployOnly = (deploy || verifyLive) && !open
    const openOnly = open && !deploy && !verifyLive
    report.runtime = await runCellFn({ slug, repoRoot, deployOnly, openOnly, log })
  }

  writeCellReport(targetCellDir, report)
  log(`[generate:${runId}] Complete! Cell persisted to scenes/${slug}/`)
  log(`  Verify: npm run cell:verify -- ${slug}`)
  log(`  Run:    npm run cell:run -- ${slug}`)

  onEvent({ stage: 'done', slug, mode: 'generate', outputDir: targetCellDir })
  return report
}

async function runCli() {
  const args = process.argv.slice(2)
  const getFlag = (flag) => {
    const idx = args.indexOf(flag)
    if (idx < 0) return undefined
    const val = args[idx + 1]
    if (!val || val.startsWith('--')) {
      throw new Error(`Flag ${flag} requires a value.`)
    }
    return val
  }

  let prompt = getFlag('--prompt')
  const specPath = getFlag('--spec')
  let name = getFlag('--name')

  if (!prompt && !specPath) {
    if (!process.stdin.isTTY) {
      console.error('Usage: npm run generate -- --prompt "<description>" [--name <slug>] [--preflight] [--stage1-only] [--deploy] [--open] [--verify-live] [--force]')
      process.exit(2)
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      prompt = (await rl.question('Describe the automated Cell you want to build:\n> ')).trim()
      if (!prompt) {
        console.error('No description provided. Aborting.')
        process.exit(2)
      }
      const suggested = slugifyPrompt(prompt)
      const enteredName = (await rl.question(`Cell slug [${suggested}]: `)).trim()
      name = enteredName || suggested
    } finally {
      rl.close()
    }
  }

  await generateCell({
    prompt,
    specPath,
    name,
    orchestratorModel: getFlag('--orchestrator-model'),
    workerModel: getFlag('--worker-model'),
    usePreflight: args.includes('--preflight'),
    stage1Only: args.includes('--stage1-only'),
    deploy: args.includes('--deploy'),
    open: args.includes('--open'),
    verifyLive: args.includes('--verify-live'),
    force: args.includes('--force'),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
