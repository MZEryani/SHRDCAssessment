import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildSecretPayload,
  buildSsmDeployCommands,
  parseArgs,
  readLocalOpenCodeGoogleKey,
  TEMPLATE_PATH,
} from '../scripts/aws-ec2.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Seam 3 Offline — AWS CloudFormation Security Invariants & SSM Lifecycle', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8')

  it('closes SSH port 22 and allows strictly TCP 80 and 443 ingress on DemoSecurityGroup', () => {
    const ingressSection = template.slice(
      template.indexOf('SecurityGroupIngress:'),
      template.indexOf('SecurityGroupEgress:'),
    )
    const fromPorts = [...ingressSection.matchAll(/FromPort:\s*(\d+)/g)].map((m) => m[1])
    const toPorts = [...ingressSection.matchAll(/ToPort:\s*(\d+)/g)].map((m) => m[1])
    assert.deepEqual(fromPorts, ['80', '443'])
    assert.deepEqual(toPorts, ['80', '443'])
    assert.doesNotMatch(template, /KeyName:/)
  })

  it('enforces IMDSv2, encrypted 30 GB gp3 EBS, t3.medium x86_64, 2 GiB swap, SHA-256 Docker Compose, and fail-fast 0600 runtime env', () => {
    assert.match(template, /HttpEndpoint:\s*enabled/)
    assert.match(template, /HttpTokens:\s*required/)
    assert.match(template, /HttpPutResponseHopLimit:\s*1/)
    assert.match(template, /VolumeType:\s*gp3/)
    assert.match(template, /VolumeSize:\s*30/)
    assert.match(template, /Encrypted:\s*true/)
    assert.match(template, /Default:\s*t3\.medium/)
    assert.match(template, /al2023-ami-kernel-default-x86_64/)
    assert.match(template, /count=2048/)
    assert.match(template, /chmod 600 \/swapfile/)
    assert.match(template, /7bdb2ce2916e5dd0354e5d129892bf96fdcdb1a9ab8eed69b9173e131db4c230/)
    assert.match(template, /sha256sum -c -/)
    assert.match(template, /jq -er '\.DEMO_ACCESS_TOKEN/)
    assert.match(template, /jq -er '\.OPENPLC_PASSWORD/)
    assert.match(template, /chmod 600 "\$TMP_ENV"/)
    assert.match(template, /chmod 700 \/usr\/local\/bin\/shrdc-refresh-env/)
  })

  it('scopes IAM instance role strictly to AmazonSSMManagedInstanceCore and the single Secrets Manager ARN', () => {
    assert.match(template, /AmazonSSMManagedInstanceCore/)
    assert.match(template, /secretsmanager:GetSecretValue/)
    assert.match(
      template,
      /arn:\$\{AWS::Partition\}:secretsmanager:\$\{AWS::Region\}:\$\{AWS::AccountId\}:secret:\$\{SecretName\}-\?\?\?\?\?\?/,
    )
    assert.doesNotMatch(template, /Resource:\s*['"]?\*['"]?/)
    assert.doesNotMatch(template, /Resource:\s*\n\s*-\s*['"]?\*['"]?/)
  })

  it('provisions permanent Elastic IP with sslip.io HTTPS URL and conditional $15/month AWS Budget', () => {
    assert.match(template, /Type:\s*AWS::EC2::EIP/)
    assert.match(template, /Type:\s*AWS::EC2::EIPAssociation/)
    assert.match(template, /https:\/\/\$\{DemoElasticIP\}\.sslip\.io/)
    assert.match(template, /HasBudgetEmail:\s*!Not \[!Equals \[!Ref BudgetAlertEmail, ''\]\]/)
    assert.match(template, /Type:\s*AWS::Budgets::Budget/)
    assert.match(template, /Condition:\s*HasBudgetEmail/)
    assert.match(template, /Amount:\s*15/)
    assert.match(template, /Unit:\s*USD/)
  })

  it('passes cfn-lint static validation cleanly when cfn-lint is installed', (t) => {
    const which = spawnSync('which', ['cfn-lint'], { encoding: 'utf8' })
    if (which.status !== 0) {
      t.skip('cfn-lint not installed on PATH')
      return
    }
    const res = spawnSync('cfn-lint', [TEMPLATE_PATH], { encoding: 'utf8' })
    assert.equal(res.status, 0, `cfn-lint failed:\n${res.stdout}\n${res.stderr}`)
  })

  it('builds valid secret payloads, safe SSM redeploy commands, OpenCode key lookup, and CLI help output offline', () => {
    const parsed = parseArgs(['deploy', '--region', 'ap-southeast-1', '--branch=main'])
    assert.equal(parsed.command, 'deploy')
    assert.equal(parsed.flags.region, 'ap-southeast-1')
    assert.equal(parsed.flags.branch, 'main')

    const payload = buildSecretPayload({ geminiApiKey: 'test-key-placeholder' })
    assert.equal(payload.GEMINI_API_KEY, 'test-key-placeholder')
    assert.ok(payload.DEMO_ACCESS_TOKEN.length >= 24)
    assert.ok(payload.OPENPLC_PASSWORD.length >= 16)

    const cmds = buildSsmDeployCommands({ branch: 'main' })
    assert.ok(cmds.some((c) => c.includes('git reset --hard origin/main')))
    assert.ok(cmds.some((c) => c.includes('/usr/local/bin/shrdc-refresh-env')))
    assert.ok(cmds.some((c) => c.includes('docker-compose.ec2.yml up -d --build demo-portal')))
    assert.throws(() => buildSsmDeployCommands({ branch: 'main; rm -rf /' }), /Invalid git branch/)
    assert.throws(() => buildSsmDeployCommands({ branch: '--upload-pack=evil' }), /Invalid git branch/)
    assert.throws(() => buildSsmDeployCommands({ branch: 'main..other' }), /Invalid git branch/)

    const fakeHome = mkdtempSync(join(tmpdir(), 'oc-home-'))
    try {
      mkdirSync(join(fakeHome, '.local', 'share', 'opencode'), { recursive: true })
      writeFileSync(join(fakeHome, '.local', 'share', 'opencode', 'opencode.db'), '')
      const extracted = readLocalOpenCodeGoogleKey({
        homeDir: fakeHome,
        execFn: () => JSON.stringify({ type: 'key', key: 'fake-google-key' }),
      })
      assert.equal(extracted, 'fake-google-key')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }

    const help = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'aws-ec2.mjs'), '--help'], {
      encoding: 'utf8',
    })
    for (const cmd of ['seed-secret', 'provision', 'deploy', 'stop', 'start', 'status', 'destroy']) {
      assert.ok(help.includes(cmd), `CLI help missing ${cmd}`)
    }
  })
})
