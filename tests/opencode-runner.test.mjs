import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import {
  parseOpenCodeNdjson,
  probeSingleModel,
  resolveDefaultModels,
  runOpenCodeAgent,
} from '../scripts/opencode-runner.mjs'

function createFakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.killSignals = []
  child.kill = (signal) => {
    child.killed = true
    child.killSignals.push(signal)
  }
  return child
}

describe('opencode-runner', () => {
  it('runs runOpenCodeAgent with expected CLI args and parses NDJSON output', async () => {
    const calls = []
    const spawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      const child = createFakeChild()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('worktree /tmp/wt-plc\n'))
        child.stdout.emit(
          'data',
          Buffer.from(
            [
              JSON.stringify({
                type: 'tool_use',
                sessionID: 'ses_run_1',
                part: { tool: 'skill', state: { input: { id: 'openplc-st' } } },
              }),
              JSON.stringify({
                type: 'step_finish',
                sessionID: 'ses_run_1',
                part: {
                  cost: 0.0015,
                  tokens: { input: 100, output: 25, reasoning: 5, cache: { read: 50, write: 10 } },
                },
              }),
              JSON.stringify({
                type: 'text',
                sessionID: 'ses_run_1',
                part: { text: 'Completed PLC program.' },
              }),
            ].join('\n') + '\n',
          ),
        )
        child.emit('close', 0)
      })
      return child
    }

    const res = await runOpenCodeAgent({
      agent: 'plc-coder',
      model: 'google/gemini-3.8-flash',
      worktreeName: 'run1-plc-coder',
      prompt: 'Generate PLC code',
      cwd: '/tmp/repo-work',
      spawnFn,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].cmd, 'opencode')
    assert.deepEqual(calls[0].args, [
      'run',
      '--standalone',
      '--auto',
      '--archived',
      '--format',
      'json',
      '--agent',
      'plc-coder',
      '--worktree',
      'run1-plc-coder',
      '--model',
      'google/gemini-3.8-flash',
      'Generate PLC code',
    ])
    assert.deepEqual(calls[0].opts, { cwd: '/tmp/repo-work', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(res.agent, 'plc-coder')
    assert.equal(res.model, 'google/gemini-3.8-flash')
    assert.equal(res.worktreePath, '/tmp/wt-plc')
    assert.equal(res.sessionId, 'ses_run_1')
    assert.deepEqual(res.skillsLoaded, ['openplc-st'])
    assert.deepEqual(res.toolsUsed, { skill: 1 })
    assert.deepEqual(res.tokens, { input: 100, output: 25, reasoning: 5, cacheRead: 50, cacheWrite: 10 })
    assert.equal(res.costUsd, 0.0015)
    assert.equal(res.finalText, 'Completed PLC program.')
    assert.ok(typeof res.startedAt === 'string' && typeof res.finishedAt === 'string')
    assert.equal(typeof res.durationMs, 'number')

    // Also verifies optional --worktree and --model flags are omitted when undefined
    await runOpenCodeAgent({
      agent: 'orchestrator',
      prompt: 'Plan work',
      cwd: '/tmp/repo-work',
      spawnFn,
    })
    assert.deepEqual(calls[1].args, [
      'run',
      '--standalone',
      '--auto',
      '--archived',
      '--format',
      'json',
      '--agent',
      'orchestrator',
      'Plan work',
    ])
  })

  it('aborts runOpenCodeAgent immediately with SIGTERM on hard timeout without close', async () => {
    let childRef
    const hangingSpawn = () => {
      childRef = createFakeChild()
      return childRef
    }

    await assert.rejects(
      runOpenCodeAgent({
        agent: 'plc-coder',
        model: 'google/gemini-3.8-flash',
        prompt: 'Hang',
        timeoutMs: 30,
        spawnFn: hangingSpawn,
      }),
      /Agent "plc-coder" Timed out after 30ms \(tools=\{\}\)/,
    )
    assert.deepEqual(childRef.killSignals, ['SIGTERM'])
  })

  it('aborts runOpenCodeAgent immediately on chunk-split 429/503 retries past maxRetryAttempts', async () => {
    for (const [status, message] of [
      [503, 'high demand'],
      [429, 'RESOURCE_EXHAUSTED'],
    ]) {
      let childRef
      const chunkSpawn = () => {
        childRef = createFakeChild()
        queueMicrotask(() => {
          childRef.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ type: 'tool_use', part: { tool: 'read' } })}\n`,
            ),
          )
          const retryLine = JSON.stringify({
            type: 'retry',
            attempt: 3,
            error: { status, message },
          })
          childRef.stdout.emit('data', Buffer.from(retryLine.slice(0, 18)))
          childRef.stdout.emit('data', Buffer.from(`${retryLine.slice(18)}\n`))
        })
        return childRef
      }

      await assert.rejects(
        runOpenCodeAgent({
          agent: 'oip-builder',
          model: 'google/gemini-3.8-flash',
          prompt: 'Build scene',
          timeoutMs: 2000,
          maxRetryAttempts: 2,
          spawnFn: chunkSpawn,
        }),
        new RegExp(`Agent "oip-builder" Fail-fast abort on HTTP ${status} retry attempt 3: ${message} \\(tools=\\{"read":1\\}\\)`),
      )
      assert.deepEqual(childRef.killSignals, ['SIGTERM'])
    }
  })

  it('rejects runOpenCodeAgent on non-zero exit, NDJSON error event, or spawn error', async () => {
    const nonZeroSpawn = () => {
      const child = createFakeChild()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('fatal crash\n'))
        child.emit('close', 2)
      })
      return child
    }

    await assert.rejects(
      runOpenCodeAgent({
        agent: 'plc-coder',
        prompt: 'Fail',
        spawnFn: nonZeroSpawn,
      }),
      /OpenCode agent "plc-coder" failed \(exit 2\): fatal crash/,
    )

    let errorEventChild
    const ndjsonErrorSpawn = () => {
      errorEventChild = createFakeChild()
      queueMicrotask(() => {
        errorEventChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ type: 'error', error: { status: 500, message: 'boom' } })}\n`),
        )
        // Must NOT abort early when abortOnErrorEvent is false; waits for close
        assert.equal(errorEventChild.killed, false)
        errorEventChild.emit('close', 0)
      })
      return errorEventChild
    }

    await assert.rejects(
      runOpenCodeAgent({
        agent: 'plc-coder',
        prompt: 'Error event',
        spawnFn: ndjsonErrorSpawn,
      }),
      /OpenCode agent "plc-coder" failed \(exit 0\): boom/,
    )

    const spawnErr = new Error('ENOENT opencode')
    const errorSpawn = () => {
      const child = createFakeChild()
      queueMicrotask(() => child.emit('error', spawnErr))
      return child
    }

    await assert.rejects(
      runOpenCodeAgent({
        agent: 'plc-coder',
        prompt: 'Missing bin',
        spawnFn: errorSpawn,
      }),
      (err) => err === spawnErr,
    )
  })

  it('probes a single model cleanly on step_finish and aborts immediately on error event', async () => {
    const calls = []
    const happySpawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      const child = createFakeChild()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'step_finish', part: { cost: 0 } })}\n`))
        child.emit('close', 0)
      })
      return child
    }

    const okRes = await probeSingleModel('google/gemini-3.8-flash', {
      cwd: '/tmp/probe-cwd',
      timeoutMs: 500,
      spawnFn: happySpawn,
    })
    assert.equal(okRes.ok, true)
    assert.equal(okRes.model, 'google/gemini-3.8-flash')
    assert.equal(typeof okRes.durationMs, 'number')
    assert.deepEqual(calls[0].args, [
      'run',
      '--standalone',
      '--auto',
      '--archived',
      '--format',
      'json',
      '-m',
      'google/gemini-3.8-flash',
      'Reply READY',
    ])

    let errorChild
    const errorEventSpawn = () => {
      errorChild = createFakeChild()
      queueMicrotask(() => {
        errorChild.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({ type: 'error', error: { status: 403, message: 'quota exhausted' } })}\n`,
          ),
        )
      })
      return errorChild
    }

    const errRes = await probeSingleModel('google/gemini-4-neon', {
      timeoutMs: 2000,
      spawnFn: errorEventSpawn,
    })
    assert.equal(errRes.ok, false)
    assert.equal(errRes.reason, 'HTTP 403 quota exhausted')
    assert.deepEqual(errorChild.killSignals, ['SIGTERM'])

    const exitFailSpawn = () => {
      const child = createFakeChild()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('bad credentials\n'))
        child.emit('close', 1)
      })
      return child
    }
    const failRes = await probeSingleModel('google/gemini-4-neon', { spawnFn: exitFailSpawn })
    assert.equal(failRes.ok, false)
    assert.equal(failRes.reason, 'bad credentials')
  })

  it('resolves default models from opencode debug agents JSON and honors env overrides', () => {
    const execCalls = []
    const fakeExecFileSync = (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts })
      return JSON.stringify([
        { id: 'orchestrator', model: { providerID: 'google', modelID: 'gemini-4-neon' } },
        { id: 'plc-coder', model: { provider: 'google', id: 'gemini-3.8-flash' } },
      ])
    }

    const fromConfig = resolveDefaultModels({
      cwd: '/tmp/repo-dir',
      env: {},
      execFileSyncFn: fakeExecFileSync,
    })
    assert.deepEqual(fromConfig, {
      orchestrator: 'google/gemini-4-neon',
      worker: 'google/gemini-3.8-flash',
    })
    assert.deepEqual(execCalls[0], {
      cmd: 'opencode',
      args: ['debug', 'agents', '--standalone'],
      opts: { cwd: '/tmp/repo-dir', encoding: 'utf8' },
    })

    const overridden = resolveDefaultModels({
      cwd: '/tmp/repo-dir',
      env: {
        OPENCODE_ORCHESTRATOR_MODEL: 'custom/orch-model',
        OPENCODE_WORKER_MODEL: 'custom/worker-model',
      },
      execFileSyncFn: fakeExecFileSync,
    })
    assert.deepEqual(overridden, {
      orchestrator: 'custom/orch-model',
      worker: 'custom/worker-model',
    })
  })
})
