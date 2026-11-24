import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function deleteBranches(repoRoot, branches) {
  for (const branch of branches) {
    if (!branch) continue
    try {
      execFileSync('git', ['-C', repoRoot, 'branch', '-D', branch], { stdio: 'pipe' })
    } catch {
      // Ignore if already deleted
    }
  }
}

/**
 * Force-remove a list of git worktree directories and prune stale worktree metadata.
 */
export function removeWorktrees(repoRoot, worktreePaths) {
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

/**
 * Return the set of active worktree paths registered in repoRoot.
 */
export function listWorktreePaths(repoRoot) {
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

/**
 * Symlink gitignored local toolchains into a worktree directory if present in repoRoot.
 */
export function linkLocalToolchains(repoRoot, targetDir) {
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
  for (const dir of ['.tools', 'Open-Industry-Project']) {
    const src = join(repoRoot, dir)
    const dst = join(targetDir, dir)
    if (existsSync(src) && !existsSync(dst)) {
      symlinkSync(src, dst, symlinkType)
    }
  }
}

/**
 * Stage pathSpec and create a --no-verify commit in cwd.
 */
export function commitPath({ cwd, pathSpec, message }) {
  const paths = Array.isArray(pathSpec) ? pathSpec : [pathSpec]
  execFileSync('git', ['-C', cwd, 'add', '--', ...paths], { stdio: 'pipe' })
  execFileSync('git', ['-C', cwd, 'commit', '--no-verify', '-m', message], { stdio: 'pipe' })
}

function commitStagedOrEmpty({ cwd, message }) {
  const staged = execFileSync('git', ['-C', cwd, 'diff', '--cached', '--name-only'], {
    encoding: 'utf8',
  }).trim()
  const commitArgs = ['-C', cwd, 'commit', '--no-verify', '-m', message]
  if (!staged) commitArgs.push('--allow-empty')
  execFileSync('git', commitArgs, { stdio: 'pipe' })
}

/**
 * Create an isolated greenfield base worktree with specified target files stripped.
 */
export function prepareGreenfieldBase({
  repoRoot = REPO_ROOT,
  runId,
  stripFiles = [],
}) {
  const baseBranch = `orchestrate/${runId}/base`
  const tempBase = realpathSync(mkdtempSync(join(tmpdir(), `orchestrate-base-${runId}-`)))
  const baseWorktreePath = join(tempBase, 'base')

  execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'add', '-b', baseBranch, baseWorktreePath, 'HEAD'],
    { stdio: 'pipe' },
  )

  for (const relPath of stripFiles) {
    const full = join(baseWorktreePath, relPath)
    if (existsSync(full)) rmSync(full, { recursive: true, force: true })
  }

  execFileSync('git', ['-C', baseWorktreePath, 'add', '-A'], { stdio: 'pipe' })
  commitStagedOrEmpty({
    cwd: baseWorktreePath,
    message: 'chore: clean greenfield base for orchestration',
  })

  linkLocalToolchains(repoRoot, baseWorktreePath)

  const cleanup = () => {
    removeWorktrees(repoRoot, [baseWorktreePath])
    deleteBranches(repoRoot, [baseBranch])
    rmSync(tempBase, { recursive: true, force: true })
  }

  return { baseBranch, baseWorktreePath, cleanup }
}

/**
 * Commit each worker worktree onto a branch and merge them into an integration worktree.
 */
export function mergeWorkerBranches({
  repoRoot = REPO_ROOT,
  runId,
  workers,
  baseRef = 'HEAD',
}) {
  const integrationBranch = `orchestrate/${runId}/integration`
  const tempBase = realpathSync(mkdtempSync(join(tmpdir(), `orchestrate-int-${runId}-`)))
  const integrationWorktreePath = join(tempBase, 'integration')
  const baseCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', baseRef], {
    encoding: 'utf8',
  }).trim()
  const createdBranches = [integrationBranch]
  const mergedBranches = []
  let conflicts = 0

  for (const worker of workers) {
    const branch = `orchestrate/${runId}/${worker.name}`
    createdBranches.push(branch)
    execFileSync('git', ['-C', worker.worktreePath, 'checkout', '-B', branch], { stdio: 'pipe' })
    if (baseRef !== 'HEAD') {
      // Align worker branch parent to baseRef while keeping worker's authored files intact
      execFileSync('git', ['-C', worker.worktreePath, 'reset', '--mixed', baseRef], {
        stdio: 'pipe',
      })
    }
    const existingOwned = (worker.ownedFiles ?? []).filter((f) =>
      existsSync(join(worker.worktreePath, f)),
    )
    if (existingOwned.length > 0) {
      execFileSync('git', ['-C', worker.worktreePath, 'add', '--', ...existingOwned], {
        stdio: 'pipe',
      })
    } else {
      execFileSync('git', ['-C', worker.worktreePath, 'add', '-A'], { stdio: 'pipe' })
    }
    commitStagedOrEmpty({
      cwd: worker.worktreePath,
      message: `chore: worker ${worker.name} output`,
    })
    const sha = execFileSync('git', ['-C', worker.worktreePath, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const filesChanged = execFileSync(
      'git',
      ['-C', worker.worktreePath, 'diff', '--name-only', `${baseCommit}..HEAD`],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    mergedBranches.push({
      worker: worker.name,
      branch,
      commitSha: sha,
      worktreePath: worker.worktreePath,
      filesChanged,
    })
  }

  execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'add', '-b', integrationBranch, integrationWorktreePath, baseRef],
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
    deleteBranches(repoRoot, createdBranches)
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

/**
 * Create a git worktree workspace adapter bound to repoRoot.
 */
export function createGitWorktreeWorkspace(repoRoot = REPO_ROOT) {
  return {
    repoRoot,
    listWorktreePaths: () => listWorktreePaths(repoRoot),
    removeWorktrees: (paths) => removeWorktrees(repoRoot, paths),
    linkLocalToolchains: (targetDir) => linkLocalToolchains(repoRoot, targetDir),
    commitPath,
    prepareGreenfieldBase: (opts = {}) => prepareGreenfieldBase({ repoRoot, ...opts }),
    mergeWorkerBranches: (opts = {}) => mergeWorkerBranches({ repoRoot, ...opts }),
  }
}
