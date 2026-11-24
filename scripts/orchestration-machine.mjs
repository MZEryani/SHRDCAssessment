export const WORKERS = ['plc-coder', 'oip-builder', 'test-engineer']

export function createGates(status = 'pending') {
  return {
    contractTest: status,
    plcTest: status,
    oipValidate: status,
    e2eModbus: status,
  }
}

export function createInitialState(config = {}) {
  const workers = {}
  for (const id of WORKERS) {
    workers[id] = { status: 'idle', selfHealAttempts: 0, worktreeOpen: false }
  }
  return {
    phase: 'idle',
    orchestratorModel: null,
    workerModel: null,
    fallbackUsed: false,
    maxWorkerSelfHeals: config.maxWorkerSelfHeals ?? 2,
    maxPostMergeRepairs: config.maxPostMergeRepairs ?? 1,
    ioContractReady: false,
    workers,
    integrationWorktreeOpen: false,
    mergeConflicts: 0,
    gates: createGates('pending'),
    repairAttempts: 0,
    proofCaptured: false,
    leakedWorktrees: 0,
    lastMessage: 'Pipeline idle.',
    lastRejected: false,
    history: [],
  }
}

function countOpenWorktrees(state) {
  const workerOpen = WORKERS.filter((id) => state.workers[id].worktreeOpen).length
  return workerOpen + (state.integrationWorktreeOpen ? 1 : 0)
}

function teardownAllWorktrees(workers) {
  const nextWorkers = {}
  for (const id of WORKERS) {
    nextWorkers[id] = { ...workers[id], worktreeOpen: false }
  }
  return nextWorkers
}

function reject(state, reason) {
  return {
    ...state,
    lastMessage: `Illegal action rejected: ${reason}`,
    lastRejected: true,
    history: [...state.history, `REJECTED: ${reason}`],
  }
}

function accept(state, patch, message) {
  const next = {
    ...state,
    ...patch,
    lastMessage: message,
    lastRejected: false,
    history: [...state.history, `${patch.phase ?? state.phase}: ${message}`],
  }
  next.leakedWorktrees = countOpenWorktrees(next)
  return next
}

export function transition(state, event) {
  switch (event.type) {
    case 'RESET':
      return createInitialState({
        maxWorkerSelfHeals: state.maxWorkerSelfHeals,
        maxPostMergeRepairs: state.maxPostMergeRepairs,
      })

    case 'START_PREFLIGHT':
      if (state.phase !== 'idle') return reject(state, 'Can only start preflight from idle.')
      return accept(state, { phase: 'preflight' }, 'Probing live model entitlement and capacity.')

    case 'PREFLIGHT_RESOLVED':
      if (state.phase !== 'preflight') return reject(state, 'Preflight is not active.')
      return accept(
        state,
        {
          phase: 'stage1_orchestrator',
          orchestratorModel: event.orchestratorModel,
          workerModel: event.workerModel,
          fallbackUsed: Boolean(event.fallbackUsed),
        },
        `Resolved models (${event.orchestratorModel} + ${event.workerModel}). Entering Stage 1.`,
      )

    case 'PREFLIGHT_FAILED':
      if (state.phase !== 'preflight') return reject(state, 'Preflight is not active.')
      return accept(state, { phase: 'failed' }, event.reason ?? 'No live-callable model pair available.')

    case 'ORCHESTRATOR_DONE': {
      if (state.phase !== 'stage1_orchestrator') return reject(state, 'Stage 1 Orchestrator is not active.')
      const nextWorkers = {}
      for (const id of WORKERS) {
        nextWorkers[id] = { status: 'running', selfHealAttempts: 0, worktreeOpen: true }
      }
      return accept(
        state,
        {
          phase: 'stage2_workers',
          ioContractReady: true,
          workers: nextWorkers,
        },
        'I/O Contract & dispatch brief ready. Spawned 3 concurrent workers in isolated git worktrees.',
      )
    }

    case 'ORCHESTRATOR_FAILED':
      if (state.phase !== 'stage1_orchestrator') return reject(state, 'Stage 1 Orchestrator is not active.')
      return accept(
        state,
        { phase: 'failed', workers: teardownAllWorktrees(state.workers), integrationWorktreeOpen: false },
        event.reason ?? 'Stage 1 Orchestrator failed.',
      )

    case 'WORKER_LOCAL_FAIL_HEAL': {
      if (state.phase !== 'stage2_workers') return reject(state, 'Stage 2 workers are not running.')
      const id = event.worker
      const worker = state.workers[id]
      if (!worker || worker.status !== 'running') return reject(state, `Worker ${id} is not running.`)
      if (worker.selfHealAttempts >= state.maxWorkerSelfHeals) {
        return accept(
          state,
          {
            phase: 'failed',
            workers: teardownAllWorktrees({
              ...state.workers,
              [id]: { ...worker, status: 'failed' },
            }),
            integrationWorktreeOpen: false,
          },
          `Worker ${id} exhausted self-heal budget (${state.maxWorkerSelfHeals}). Cleaned up all worktrees.`,
        )
      }
      return accept(
        state,
        {
          workers: {
            ...state.workers,
            [id]: { ...worker, selfHealAttempts: worker.selfHealAttempts + 1 },
          },
        },
        `Worker ${id} self-healing in-worktree (attempt ${worker.selfHealAttempts + 1}/${state.maxWorkerSelfHeals}).`,
      )
    }

    case 'WORKER_API_ABORT': {
      if (state.phase !== 'stage2_workers') return reject(state, 'Stage 2 workers are not running.')
      const id = event.worker
      return accept(
        state,
        {
          phase: 'failed',
          workers: teardownAllWorktrees({
            ...state.workers,
            [id]: { ...(state.workers[id] ?? {}), status: 'aborted' },
          }),
          integrationWorktreeOpen: false,
        },
        event.reason ?? `Worker ${id} aborted on fail-fast retry/timeout guard. Cleaned up all worktrees.`,
      )
    }

    case 'WORKER_SUCCEED': {
      if (state.phase !== 'stage2_workers') return reject(state, 'Stage 2 workers are not running.')
      const id = event.worker
      const worker = state.workers[id]
      if (!worker || worker.status !== 'running') return reject(state, `Worker ${id} is not running.`)
      const nextWorkers = { ...state.workers, [id]: { ...worker, status: 'done' } }
      const allDone = WORKERS.every((k) => nextWorkers[k].status === 'done')
      return accept(
        state,
        {
          workers: nextWorkers,
          phase: allDone ? 'stage3_merge' : 'stage2_workers',
        },
        allDone
          ? `Worker ${id} completed. All 3 workers done — ready for Stage 3 merge.`
          : `Worker ${id} completed in its isolated worktree.`,
      )
    }

    case 'MERGE_CLEAN':
      if (state.phase !== 'stage3_merge') return reject(state, 'Cannot merge until all 3 workers complete Stage 2.')
      return accept(
        state,
        {
          phase: 'stage4_verify',
          integrationWorktreeOpen: true,
          mergeConflicts: 0,
        },
        'Merged 3 worker branches into integration worktree with 0 conflicts.',
      )

    case 'MERGE_CONFLICT':
      if (state.phase !== 'stage3_merge') return reject(state, 'Cannot merge until all 3 workers complete Stage 2.')
      return accept(
        state,
        {
          phase: 'failed',
          mergeConflicts: event.conflicts ?? 1,
          workers: teardownAllWorktrees(state.workers),
          integrationWorktreeOpen: false,
        },
        `Merge produced ${event.conflicts ?? 1} conflict(s). Cleaned up all worktrees.`,
      )

    case 'GATES_ALL_PASS':
      if (state.phase !== 'stage4_verify') return reject(state, 'Stage 4 verification is not active.')
      return accept(
        state,
        {
          phase: 'done',
          gates: createGates('pass'),
          proofCaptured: true,
          workers: teardownAllWorktrees(state.workers),
          integrationWorktreeOpen: false,
        },
        'All verification gates passed. Proof captured and all worktrees cleaned up.',
      )

    case 'GATE_FAIL_REPAIR': {
      if (state.phase !== 'stage4_verify') return reject(state, 'Stage 4 verification is not active.')
      const gates = event.gates
        ? { ...createGates('pending'), ...event.gates }
        : { contractTest: 'pass', plcTest: 'pass', oipValidate: 'fail', e2eModbus: 'pending' }
      if (state.repairAttempts >= state.maxPostMergeRepairs) {
        return accept(
          state,
          {
            phase: 'failed',
            gates,
            workers: teardownAllWorktrees(state.workers),
            integrationWorktreeOpen: false,
          },
          `Post-merge gate failed and repair budget (${state.maxPostMergeRepairs}) exhausted. Cleaned up all worktrees.`,
        )
      }
      return accept(
        state,
        {
          phase: 'stage4_repair',
          gates,
          repairAttempts: state.repairAttempts + 1,
        },
        `Post-merge gate failed; dispatching Orchestrator repair pass (${state.repairAttempts + 1}/${state.maxPostMergeRepairs}).`,
      )
    }

    case 'REPAIR_PATCH_APPLIED':
      if (state.phase !== 'stage4_repair') return reject(state, 'Post-merge repair pass is not active.')
      return accept(
        state,
        {
          phase: 'stage4_verify',
          gates: createGates('pending'),
        },
        'Orchestrator patched integration worktree. Re-running Stage 4 verification gates.',
      )

    default:
      return reject(state, `Unknown event ${event.type}`)
  }
}
