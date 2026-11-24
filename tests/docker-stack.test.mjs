import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8')
}

describe('Docker 3-Container EC2 Stack & Local Override Configuration', () => {
  it('pins OIP commit SHA, STruC++ v0.8.0 + SHA-256, OpenCode v2.4.0 + SHA-256, and git worktree init in Dockerfile', () => {
    const dockerfile = readRepoFile('Dockerfile')
    assert.match(dockerfile, /AS oip-builder/)
    assert.match(dockerfile, /AS portal-web-builder/)
    assert.match(dockerfile, /COPY --from=portal-web-builder \/portal-web\/dist \/app\/portal\/web\/dist/)
    assert.match(dockerfile, /OIP_COMMIT=0afba0117eaa19589b4ae9c66412ae29c0e664a8/)
    assert.match(dockerfile, /STRUCPP_VERSION=0\.8\.0/)
    assert.match(dockerfile, /cf2b919620ca389186d9cc5be293f7d655511c183d1b49a77220ec60e0584e71/)
    assert.match(dockerfile, /0d87c13ad2911fec9300a63acf290c0e3164290fdc235c39ea1dfe0399ed9e91/)
    assert.match(dockerfile, /OPENCODE_VERSION=2\.4\.0/)
    assert.match(dockerfile, /66cf6adeb02fbfe9ccbb1f6497fcf46cecf2d299a1dc3a7a32e01ea30ff20201/)
    assert.match(dockerfile, /fed468566215fd38b26abab99018240c0d30772d3f45aee25621664ceff7e360/)
    assert.match(dockerfile, /sha256sum -c -/)
    assert.match(dockerfile, /\bg\+\+\s/)
    assert.match(dockerfile, /git init -b main/)
    assert.match(dockerfile, /^USER node$/m)
    assert.match(dockerfile, /PORTAL_CELLS_DIR=\/data\/cells/)
    assert.match(dockerfile, /HEALTHCHECK/)
  })

  it('excludes secrets, local tools, and untracked test scenes in .dockerignore', () => {
    const ignore = readRepoFile('.dockerignore')
    for (const pattern of [
      '.git',
      '.env',
      '.opencode/auth*',
      '*.key',
      '*.pem',
      '.scratch',
      '.tools',
      'Open-Industry-Project',
      'portal/web/node_modules',
      'portal/web/dist',
      'scenes/*',
      '!scenes/conveyor-cell',
    ]) {
      assert.ok(ignore.includes(pattern), `.dockerignore missing ${pattern}`)
    }
  })

  it('isolates Demo Portal and OpenPLC on shrdc-internal with Caddy as sole host-published service', () => {
    const compose = readRepoFile('docker-compose.ec2.yml')
    assert.match(compose, /^name:\s*shrdc-ec2$/m)
    assert.match(compose, /^\s*caddy:/m)
    assert.match(compose, /^\s*demo-portal:/m)
    assert.match(compose, /^\s*openplc-runtime:/m)
    assert.match(compose, /image:\s*caddy:2-alpine/)
    assert.match(compose, /image:\s*ghcr\.io\/autonomy-logic\/openplc-runtime:latest/)
    assert.match(compose, /OPENPLC_URL:\s*"https:\/\/openplc-runtime:8443"/)
    assert.match(compose, /OIP_MODBUS_HOST:\s*"demo-portal"/)
    assert.match(compose, /generated-cells:\/data\/cells/)
    assert.match(compose, /caddy-data:\/data/)
    assert.match(compose, /caddy-config:\/config/)

    // Only Caddy may declare host-published `ports:`
    const portsMatches = compose.match(/^\s+ports:/gm) ?? []
    assert.equal(portsMatches.length, 1, 'only caddy should publish host ports')
    assert.match(compose, /"80:80"/)
    assert.match(compose, /"443:443"/)
  })

  it('configures Caddyfiles for non-buffered SSE streaming and preserves root local docker-compose.yml', () => {
    const prodCaddy = readRepoFile('infra/Caddyfile')
    const localCaddy = readRepoFile('infra/Caddyfile.local')
    assert.match(prodCaddy, /\{\$DEMO_DOMAIN\}/)
    assert.match(prodCaddy, /reverse_proxy demo-portal:3000/)
    assert.match(prodCaddy, /flush_interval -1/)
    assert.match(localCaddy, /:80/)
    assert.match(localCaddy, /reverse_proxy demo-portal:3000/)
    assert.match(localCaddy, /flush_interval -1/)

    const localOverride = readRepoFile('docker-compose.local.yml')
    assert.match(localOverride, /FORCE_SECURE_COOKIES:\s*"0"/)
    assert.match(localOverride, /Caddyfile\.local/)

    // Existing root desktop Compose file remains intact
    const rootCompose = readRepoFile('docker-compose.yml')
    assert.match(rootCompose, /"8443:8443"/)
    assert.match(rootCompose, /host\.docker\.internal:host-gateway/)
  })
})
