import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createGitWorktreeWorkspace } from '../scripts/git-worktree-workspace.mjs'

function createTempRepo() {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'git-wt-ws-test-')))
  const repoDir = join(tempDir, 'repo')
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'], { stdio: 'pipe' })
  writeFileSync(join(repoDir, 'README.md'), '# test\n')
  writeFileSync(join(repoDir, 'strip-me.txt'), 'remove in greenfield\n')
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'pipe' })
  return { tempDir, repoDir }
}

function listBranches(repoDir, pattern = 'orchestrate/*') {
  return execFileSync('git', ['-C', repoDir, 'branch', '--list', pattern], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
}

describe('git-worktree-workspace', () => {
  it('prepares greenfield base, commits synthesized path via commitPath, and cleans up with zero leaks', () => {
    const { tempDir, repoDir } = createTempRepo()
    try {
      const workspace = createGitWorktreeWorkspace(repoDir)
      assert.equal(workspace.repoRoot, repoDir)

      const base = workspace.prepareGreenfieldBase({
        runId: 'gf-slice',
        stripFiles: ['strip-me.txt'],
      })

      try {
        assert.equal(existsSync(join(repoDir, 'strip-me.txt')), true)
        assert.equal(existsSync(join(base.baseWorktreePath, 'strip-me.txt')), false)
        assert.equal(existsSync(join(base.baseWorktreePath, 'README.md')), true)
        assert.equal(workspace.listWorktreePaths().has(base.baseWorktreePath), true)

        mkdirSync(join(base.baseWorktreePath, 'openplc'), { recursive: true })
        writeFileSync(join(base.baseWorktreePath, 'openplc', 'io-contract.json'), '{"ok":true}\n')
        workspace.commitPath({
          cwd: base.baseWorktreePath,
          pathSpec: 'openplc/io-contract.json',
          message: 'feat: add contract',
        })

        const lastMsg = execFileSync(
          'git',
          ['-C', base.baseWorktreePath, 'log', '-1', '--pretty=%s'],
          { encoding: 'utf8' },
        ).trim()
        assert.equal(lastMsg, 'feat: add contract')
        const committedFiles = execFileSync(
          'git',
          ['-C', base.baseWorktreePath, 'show', '--name-only', '--pretty=format:', 'HEAD'],
          { encoding: 'utf8' },
        ).trim()
        assert.equal(committedFiles, 'openplc/io-contract.json')
      } finally {
        base.cleanup()
      }

      assert.equal(existsSync(base.baseWorktreePath), false)
      assert.deepEqual([...workspace.listWorktreePaths()], [repoDir])
      assert.deepEqual(listBranches(repoDir), [])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('merges worker branches cleanly and cleans up all worktrees and branches', () => {
    const { tempDir, repoDir } = createTempRepo()
    try {
      const workspace = createGitWorktreeWorkspace(repoDir)
      const wt1 = join(tempDir, 'wt-1')
      const wt2 = join(tempDir, 'wt-2')
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', wt1, 'HEAD'], { stdio: 'pipe' })
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', wt2, 'HEAD'], { stdio: 'pipe' })

      writeFileSync(join(wt1, 'a.txt'), 'worker 1\n')
      writeFileSync(join(wt1, 'ignored.txt'), 'unowned\n')
      writeFileSync(join(wt2, 'b.txt'), 'worker 2\n')

      const merged = workspace.mergeWorkerBranches({
        runId: 'clean-run',
        workers: [
          { name: 'plc-coder', worktreePath: wt1, ownedFiles: ['a.txt'] },
          { name: 'oip-builder', worktreePath: wt2, ownedFiles: ['b.txt'] },
        ],
      })

      try {
        assert.equal(merged.conflicts, 0)
        assert.equal(merged.mergedBranches.length, 2)
        assert.deepEqual(merged.mergedBranches[0].filesChanged, ['a.txt'])
        assert.deepEqual(merged.mergedBranches[1].filesChanged, ['b.txt'])
        assert.equal(readFileSync(join(merged.integrationWorktreePath, 'a.txt'), 'utf8'), 'worker 1\n')
        assert.equal(readFileSync(join(merged.integrationWorktreePath, 'b.txt'), 'utf8'), 'worker 2\n')
        assert.equal(existsSync(join(merged.integrationWorktreePath, 'ignored.txt')), false)
      } finally {
        merged.cleanup()
      }

      assert.equal(existsSync(merged.integrationWorktreePath), false)
      assert.deepEqual([...workspace.listWorktreePaths()], [repoDir])
      assert.deepEqual(listBranches(repoDir), [])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects real merge conflicts (conflicts === 1) when two workers edit the same file differently and cleans up completely', () => {
    const { tempDir, repoDir } = createTempRepo()
    try {
      const workspace = createGitWorktreeWorkspace(repoDir)
      const wt1 = join(tempDir, 'wt-conflict-1')
      const wt2 = join(tempDir, 'wt-conflict-2')
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', wt1, 'HEAD'], { stdio: 'pipe' })
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', wt2, 'HEAD'], { stdio: 'pipe' })

      writeFileSync(join(wt1, 'README.md'), '# edited by worker 1\n')
      writeFileSync(join(wt2, 'README.md'), '# edited by worker 2\n')

      const merged = workspace.mergeWorkerBranches({
        runId: 'conflict-run',
        workers: [
          { name: 'plc-coder', worktreePath: wt1 },
          { name: 'oip-builder', worktreePath: wt2 },
        ],
      })

      try {
        assert.equal(merged.conflicts, 1)
        assert.equal(merged.mergedBranches.length, 2)
        assert.ok(merged.mergedBranches[0].mergeSha)
        assert.equal(merged.mergedBranches[1].mergeSha, undefined)
      } finally {
        merged.cleanup()
      }

      assert.equal(existsSync(merged.integrationWorktreePath), false)
      assert.deepEqual([...workspace.listWorktreePaths()], [repoDir])
      assert.deepEqual(listBranches(repoDir), [])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('symlinks present local toolchains without overwriting existing targets', () => {
    const { tempDir, repoDir } = createTempRepo()
    try {
      const toolsDir = join(repoDir, '.tools')
      const oipDir = join(repoDir, 'Open-Industry-Project')
      mkdirSync(toolsDir, { recursive: true })
      mkdirSync(oipDir, { recursive: true })
      writeFileSync(join(toolsDir, 'marker.txt'), 'tool\n')

      const targetDir = join(tempDir, 'target-wt')
      mkdirSync(join(targetDir, 'Open-Industry-Project'), { recursive: true })
      writeFileSync(join(targetDir, 'Open-Industry-Project', 'keep.txt'), 'keep\n')

      const workspace = createGitWorktreeWorkspace(repoDir)
      workspace.linkLocalToolchains(targetDir)

      assert.equal(lstatSync(join(targetDir, '.tools')).isSymbolicLink(), true)
      assert.equal(readFileSync(join(targetDir, '.tools', 'marker.txt'), 'utf8'), 'tool\n')
      assert.equal(lstatSync(join(targetDir, 'Open-Industry-Project')).isSymbolicLink(), false)
      assert.equal(readFileSync(join(targetDir, 'Open-Industry-Project', 'keep.txt'), 'utf8'), 'keep\n')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
