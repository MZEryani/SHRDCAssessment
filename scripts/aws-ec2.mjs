#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-1'
export const DEFAULT_STACK_NAME = process.env.AWS_STACK_NAME || 'shrdc-assessment-ec2'
export const DEFAULT_SECRET_NAME = process.env.AWS_SECRET_NAME || 'shrdc-assessment/demo-portal'
export const TEMPLATE_PATH = join(REPO_ROOT, 'infra', 'cloudformation.yaml')

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (!arg.startsWith('--')) continue
    const eqIdx = arg.indexOf('=')
    if (eqIdx > 0) {
      flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
    } else {
      const next = rest[i + 1]
      if (next && !next.startsWith('--')) {
        flags[arg.slice(2)] = next
        i += 1
      } else {
        flags[arg.slice(2)] = 'true'
      }
    }
  }
  return { command, flags }
}

/**
 * Silently extract the active Google API key from OpenCode's local SQLite credential store.
 * Never logs or echoes the key value.
 */
export function readLocalOpenCodeGoogleKey({ homeDir = homedir(), execFn = execFileSync } = {}) {
  const dbPath = join(homeDir, '.local', 'share', 'opencode', 'opencode.db')
  if (!existsSync(dbPath)) return ''
  try {
    const raw = execFn(
      'sqlite3',
      [dbPath, "SELECT value FROM credential WHERE integration_id='google' AND active=1 LIMIT 1;"],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    return typeof parsed?.key === 'string' ? parsed.key.trim() : ''
  } catch {
    return ''
  }
}

export function buildSecretPayload({
  demoAccessToken,
  openplcPassword,
  geminiApiKey,
  randomBytesFn = randomBytes,
} = {}) {
  const token =
    demoAccessToken && demoAccessToken.trim()
      ? demoAccessToken.trim()
      : randomBytesFn(24).toString('base64url')
  const password =
    openplcPassword && openplcPassword.trim()
      ? openplcPassword.trim()
      : randomBytesFn(18).toString('base64url')
  const apiKey = typeof geminiApiKey === 'string' ? geminiApiKey.trim() : ''
  return {
    DEMO_ACCESS_TOKEN: token,
    OPENPLC_PASSWORD: password,
    GEMINI_API_KEY: apiKey,
  }
}

export function validateBranchName(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
    throw new Error(`Invalid git branch name: ${branch}`)
  }
  return branch
}

export function validateDomainName(domain) {
  if (typeof domain !== 'string' || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error(`Invalid domain name: ${domain}`)
  }
  return domain
}

export function buildSsmDeployCommands({ branch = 'main', domain = '' } = {}) {
  validateBranchName(branch)
  const domainStep = domain
    ? [
        `printf '%s\\n' '${validateDomainName(domain)}' > /etc/shrdc-domain`,
        `sed -i "s/^DEMO_DOMAIN=.*/DEMO_DOMAIN=${domain}/" /opt/shrdc-assessment/.env.runtime || true`,
      ]
    : []
  return [
    'set -euo pipefail',
    'cd /opt/shrdc-assessment',
    `git fetch origin -- ${branch}`,
    `git reset --hard origin/${branch}`,
    ...domainStep,
    '/usr/local/bin/shrdc-refresh-env',
    ...(domain ? [`sed -i "s/^DEMO_DOMAIN=.*/DEMO_DOMAIN=${domain}/" /opt/shrdc-assessment/.env.runtime`] : []),
    'docker compose --env-file .env.runtime -f docker-compose.ec2.yml up -d --build demo-portal caddy',
    'docker compose --env-file .env.runtime -f docker-compose.ec2.yml ps',
  ]
}

function runAws(args, { region, capture = true } = {}) {
  const fullArgs = region ? ['--region', region, ...args] : args
  if (capture) {
    return execFileSync('aws', fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  execFileSync('aws', fullArgs, { stdio: 'inherit' })
  return ''
}

function getStackOutputs({ stackName, region }) {
  const raw = runAws(
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      stackName,
      '--query',
      'Stacks[0].Outputs',
      '--output',
      'json',
    ],
    { region },
  )
  const arr = JSON.parse(raw || '[]')
  const map = {}
  for (const item of arr) {
    if (item?.OutputKey) map[item.OutputKey] = item.OutputValue
  }
  return map
}

function seedSecret({ secretName, region }) {
  const geminiApiKey =
    (process.env.GEMINI_API_KEY || '').trim() || readLocalOpenCodeGoogleKey()
  if (!geminiApiKey) {
    throw new Error(
      'No GEMINI_API_KEY found in environment or local OpenCode credential store (~/.local/share/opencode/opencode.db). Set GEMINI_API_KEY in your shell before running aws:seed-secret.',
    )
  }

  const payload = buildSecretPayload({
    demoAccessToken: process.env.DEMO_ACCESS_TOKEN,
    openplcPassword: process.env.OPENPLC_PASSWORD,
    geminiApiKey,
  })

  const tempDir = mkdtempSync(join(tmpdir(), 'shrdc-secret-'))
  const secretFile = join(tempDir, 'secret.json')
  try {
    writeFileSync(secretFile, JSON.stringify(payload), { mode: 0o600 })
    chmodSync(secretFile, 0o600)

    let exists = false
    try {
      runAws(['secretsmanager', 'describe-secret', '--secret-id', secretName], { region })
      exists = true
    } catch {
      exists = false
    }

    const resJson = exists
      ? runAws(
          [
            'secretsmanager',
            'put-secret-value',
            '--secret-id',
            secretName,
            '--secret-string',
            `file://${secretFile}`,
            '--output',
            'json',
          ],
          { region },
        )
      : runAws(
          [
            'secretsmanager',
            'create-secret',
            '--name',
            secretName,
            '--description',
            'SHRDC Assessment EC2 Demo Portal credentials (zero-echo seeded)',
            '--secret-string',
            `file://${secretFile}`,
            '--output',
            'json',
          ],
          { region },
        )

    const meta = JSON.parse(resJson)
    console.log(`[aws] ${exists ? 'Updated' : 'Created'} secret "${secretName}" in ${region}`)
    console.log(`[aws] ARN: ${meta.ARN}`)
    console.log('[aws] Keys seeded: DEMO_ACCESS_TOKEN, OPENPLC_PASSWORD, GEMINI_API_KEY (values redacted)')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function provisionStack({ stackName, region, secretName, budgetEmail, branch, instanceType, domain }) {
  validateBranchName(branch)
  const paramOverrides = [
    `SecretName=${secretName}`,
    `RepoBranch=${branch}`,
  ]
  if (instanceType) {
    paramOverrides.push(`InstanceType=${instanceType}`)
  }
  if (domain) {
    paramOverrides.push(`CustomDomain=${validateDomainName(domain)}`)
  }
  if (budgetEmail) {
    paramOverrides.push(`BudgetAlertEmail=${budgetEmail}`)
  }
  console.log(`[aws] Deploying CloudFormation stack "${stackName}" in ${region}...`)
  runAws(
    [
      'cloudformation',
      'deploy',
      '--template-file',
      TEMPLATE_PATH,
      '--stack-name',
      stackName,
      '--capabilities',
      'CAPABILITY_IAM',
      '--no-fail-on-empty-changeset',
      '--parameter-overrides',
      ...paramOverrides,
    ],
    { region, capture: false },
  )
  const outputs = getStackOutputs({ stackName, region })
  console.log('[aws] Stack outputs:')
  for (const [k, v] of Object.entries(outputs)) {
    console.log(`  ${k}: ${v}`)
  }
}

async function deployViaSsm({ stackName, region, branch, domain }) {
  const outputs = getStackOutputs({ stackName, region })
  const instanceId = outputs.InstanceId
  if (!instanceId) {
    throw new Error(`Stack "${stackName}" does not expose InstanceId output`)
  }
  const commands = buildSsmDeployCommands({ branch, domain })
  console.log(`[aws] Sending SSM redeploy command to ${instanceId} (branch: ${branch})...`)
  const sendJson = runAws(
    [
      'ssm',
      'send-command',
      '--instance-ids',
      instanceId,
      '--document-name',
      'AWS-RunShellScript',
      '--comment',
      `Redeploy SHRDC Demo Portal (${branch})`,
      '--parameters',
      JSON.stringify({ commands }),
      '--output',
      'json',
    ],
    { region },
  )
  const commandId = JSON.parse(sendJson).Command.CommandId
  console.log(`[aws] SSM CommandId: ${commandId} — waiting for completion...`)

  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000))
    let inv
    try {
      const raw = runAws(
        [
          'ssm',
          'get-command-invocation',
          '--command-id',
          commandId,
          '--instance-id',
          instanceId,
          '--output',
          'json',
        ],
        { region },
      )
      inv = JSON.parse(raw)
    } catch {
      continue
    }
    const status = inv.Status
    if (status === 'Success') {
      console.log('[aws] SSM redeploy succeeded.')
      if (inv.StandardOutputContent) console.log(inv.StandardOutputContent.trim())
      if (outputs.DemoUrl) console.log(`[aws] Demo URL: ${outputs.DemoUrl}`)
      return
    }
    if (status === 'Failed' || status === 'Cancelled' || status === 'TimedOut') {
      throw new Error(
        `SSM redeploy ${status}:\n${inv.StandardErrorContent || inv.StandardOutputContent || '(no output)'}`,
      )
    }
  }
  throw new Error(`Timed out waiting for SSM command ${commandId}`)
}

function stopInstance({ stackName, region }) {
  const { InstanceId } = getStackOutputs({ stackName, region })
  if (!InstanceId) throw new Error(`Stack "${stackName}" missing InstanceId`)
  console.log(`[aws] Stopping EC2 instance ${InstanceId} (EBS volumes and Elastic IP preserved)...`)
  runAws(['ec2', 'stop-instances', '--instance-ids', InstanceId], { region })
  runAws(['ec2', 'wait', 'instance-stopped', '--instance-ids', InstanceId], { region })
  console.log(`[aws] Instance ${InstanceId} stopped.`)
}

function startInstance({ stackName, region }) {
  const outputs = getStackOutputs({ stackName, region })
  const instanceId = outputs.InstanceId
  if (!instanceId) throw new Error(`Stack "${stackName}" missing InstanceId`)
  console.log(`[aws] Starting EC2 instance ${instanceId}...`)
  runAws(['ec2', 'start-instances', '--instance-ids', instanceId], { region })
  runAws(['ec2', 'wait', 'instance-running', '--instance-ids', instanceId], { region })
  console.log(`[aws] Instance ${instanceId} running.`)
  if (outputs.DemoUrl) console.log(`[aws] Demo URL: ${outputs.DemoUrl}`)
}

function showStatus({ stackName, region }) {
  const outputs = getStackOutputs({ stackName, region })
  const instanceId = outputs.InstanceId
  let state = 'UNKNOWN'
  if (instanceId) {
    state = runAws(
      [
        'ec2',
        'describe-instances',
        '--instance-ids',
        instanceId,
        '--query',
        'Reservations[0].Instances[0].State.Name',
        '--output',
        'text',
      ],
      { region },
    )
  }
  console.log(`Stack:    ${stackName} (${region})`)
  console.log(`Instance: ${instanceId || 'none'} (${state})`)
  console.log(`Demo URL: ${outputs.DemoUrl || 'none'}`)
  if (outputs.SsmSessionCommand) console.log(`SSM CLI:  ${outputs.SsmSessionCommand}`)
}

function destroyStack({ stackName, region }) {
  console.log(`[aws] Deleting CloudFormation stack "${stackName}" in ${region}...`)
  runAws(['cloudformation', 'delete-stack', '--stack-name', stackName], { region })
  runAws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stackName], { region })
  console.log(`[aws] Stack "${stackName}" deleted cleanly.`)
}

function printHelp() {
  console.log(`Usage: node scripts/aws-ec2.mjs <command> [--region <region>] [--stack <name>] [--secret <name>] [--branch <branch>] [--budget-email <email>]

Commands:
  seed-secret   Zero-echo seed DEMO_ACCESS_TOKEN, OPENPLC_PASSWORD, and GEMINI_API_KEY into AWS Secrets Manager
  provision     Deploy infra/cloudformation.yaml (VPC, SG 80/443, IMDSv2 t3.medium, EIP, IAM, optional $15 Budget)
  deploy        Fast SSM redeploy (git reset + refresh secrets + rebuild demo-portal keeping OIP cache)
  stop          Stop EC2 instance to pause compute billing while preserving EBS and Elastic IP
  start         Start stopped EC2 instance and print stable https://<eip>.sslip.io URL
  status        Show stack outputs and current EC2 instance state
  destroy       Tear down the entire CloudFormation stack (EC2, EIP, VPC, IAM, Budget)`)
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2))
  const region = flags.region || DEFAULT_REGION
  const stackName = flags.stack || DEFAULT_STACK_NAME
  const secretName = flags.secret || DEFAULT_SECRET_NAME
  const branch = flags.branch || 'main'
  const instanceType = flags['instance-type'] || ''
  const domain = flags.domain || ''
  const budgetEmail = flags['budget-email'] || process.env.BUDGET_ALERT_EMAIL || ''

  switch (command) {
    case 'seed-secret':
      seedSecret({ secretName, region })
      return
    case 'provision':
      provisionStack({ stackName, region, secretName, budgetEmail, branch, instanceType, domain })
      return
    case 'deploy':
      await deployViaSsm({ stackName, region, branch, domain })
      return
    case 'stop':
      stopInstance({ stackName, region })
      return
    case 'start':
      startInstance({ stackName, region })
      return
    case 'status':
      showStatus({ stackName, region })
      return
    case 'destroy':
      destroyStack({ stackName, region })
      return
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      return
    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[aws] FAILED:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
