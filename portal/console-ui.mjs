const SHARED_THEME_CSS = `
    :root {
      --bg-light: #f8fafc;
      --bg-dark: #0f1115;
      --card-light: #ffffff;
      --card-dark: #181b21;
      --fg-light: #0f172a;
      --fg-dark: #f1f5f9;
      --muted-light: #475569;
      --muted-dark: #94a3b8;
      --border-light: #cbd5e1;
      --border-dark: #2d3340;
      --primary-light: #2563eb;
      --primary-dark: #3b82f6;
      --accent-light: #e2e8f0;
      --accent-dark: #252b36;
      --ok-light: #047857;
      --ok-dark: #34d399;
      --warn-light: #b45309;
      --warn-dark: #fbbf24;

      --bg: var(--bg-light);
      --card: var(--card-light);
      --fg: var(--fg-light);
      --muted: var(--muted-light);
      --border: var(--border-light);
      --primary: var(--primary-light);
      --accent: var(--accent-light);
      --ok: var(--ok-light);
      --warn: var(--warn-light);
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: var(--bg-dark);
        --card: var(--card-dark);
        --fg: var(--fg-dark);
        --muted: var(--muted-dark);
        --border: var(--border-dark);
        --primary: var(--primary-dark);
        --accent: var(--accent-dark);
        --ok: var(--ok-dark);
        --warn: var(--warn-dark);
      }
    }
    @supports (color: light-dark(white, black)) {
      :root {
        --bg: light-dark(var(--bg-light), var(--bg-dark));
        --card: light-dark(var(--card-light), var(--card-dark));
        --fg: light-dark(var(--fg-light), var(--fg-dark));
        --muted: light-dark(var(--muted-light), var(--muted-dark));
        --border: light-dark(var(--border-light), var(--border-dark));
        --primary: light-dark(var(--primary-light), var(--primary-dark));
        --accent: light-dark(var(--accent-light), var(--accent-dark));
        --ok: light-dark(var(--ok-light), var(--ok-dark));
        --warn: light-dark(var(--warn-light), var(--warn-dark));
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.55;
    }
    :where(a:any-link, button, input, textarea, [tabindex]):focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }
`

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function renderLoginPage({ errorMessage = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Sign In | SHRDC Assessment EC2 Demo Console</title>
  <style>
${SHARED_THEME_CSS}
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 1.5rem;
    }
    main {
      width: 100%;
      max-width: 440px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.75rem;
    }
    h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
    p { margin: 0 0 1.25rem; font-size: 0.875rem; color: var(--muted); }
    .field { display: flex; flex-direction: column; gap: 0.35rem; margin-block-end: 1.25rem; }
    label { font-size: 0.875rem; font-weight: 600; }
    .hint { font-size: 0.8rem; color: var(--muted); }
    .input-row { display: flex; gap: 0.5rem; }
    input {
      flex: 1;
      font: inherit;
      font-size: max(1rem, 1em);
      min-height: 44px;
      padding: 0.55rem 0.75rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
    }
    button {
      font: inherit;
      min-height: 44px;
      padding: 0.55rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--fg);
      cursor: pointer;
      font-weight: 600;
    }
    button[type="submit"] {
      width: 100%;
      background: var(--primary);
      border-color: var(--primary);
      color: #ffffff;
    }
    .error {
      margin-block-end: 1rem;
      padding: 0.75rem;
      border-radius: 0.5rem;
      border: 1px solid rgba(220, 38, 38, 0.5);
      background: rgba(220, 38, 38, 0.12);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>SHRDC Assessment EC2 Demo</h1>
    <p>Enter the recruiter demo passphrase or open the shareable magic link provided in your assessment notes.</p>
    ${errorMessage ? `<div role="alert" class="error">${escapeHtml(errorMessage)}</div>` : ''}
    <form method="POST" action="/auth/login">
      <div class="field">
        <label for="access-token">Demo Passphrase</label>
        <span id="token-hint" class="hint">Grants cookie-backed access to OpenPLC Runtime v4, OIP 3D, and Task 2 generation.</span>
        <div class="input-row">
          <input id="access-token" name="token" type="password" autocomplete="current-password" aria-describedby="token-hint" ${errorMessage ? 'aria-invalid="true"' : ''} required />
          <button type="button" id="toggle-token" aria-pressed="false" aria-label="Show passphrase">Show</button>
        </div>
      </div>
      <button type="submit">Unlock Demo Console</button>
    </form>
  </main>
  <script>
    const input = document.getElementById('access-token')
    const toggle = document.getElementById('toggle-token')
    toggle.addEventListener('click', () => {
      const showing = input.type === 'text'
      input.type = showing ? 'password' : 'text'
      toggle.setAttribute('aria-pressed', String(!showing))
      toggle.setAttribute('aria-label', showing ? 'Show passphrase' : 'Hide passphrase')
      toggle.textContent = showing ? 'Show' : 'Hide'
    })
  </script>
</body>
</html>`
}

export function renderConsolePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>SHRDC Assessment · EC2 Demo Console</title>
  <style>
${SHARED_THEME_CSS}
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .visually-hidden:where(:not(:focus-within, :active)) {
      position: absolute !important;
      clip-path: inset(50%) !important;
      overflow: hidden !important;
      width: 1px !important;
      height: 1px !important;
      margin: -1px !important;
      padding: 0 !important;
      border: 0 !important;
      white-space: nowrap !important;
    }
    .skip-link:focus-within, .skip-link:focus {
      position: fixed;
      top: 0.75rem;
      left: 0.75rem;
      z-index: 100;
      padding: 0.5rem 0.9rem;
      border-radius: 0.5rem;
      background: var(--primary);
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
    }
    .page-grid {
      max-width: 1180px;
      margin: 0 auto;
      padding: 2rem 1.25rem 4rem;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 2.25rem;
      align-items: start;
    }
    @media (max-width: 960px) {
      .page-grid { grid-template-columns: 1fr; }
    }
    .page-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.25rem;
      margin-bottom: 2rem;
    }
    .eyebrow {
      margin: 0 0 0.35rem;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    h1 { margin: 0 0 0.5rem; font-size: 1.6rem; line-height: 1.25; }
    .lead { margin: 0; font-size: 0.95rem; color: var(--muted); }
    .act {
      padding-top: 1.75rem;
      margin-top: 1.75rem;
      border-top: 1px solid var(--border);
    }
    .act:first-of-type { padding-top: 0; margin-top: 0; border-top: 0; }
    .act-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
    .act-num {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      background: var(--primary);
      color: #ffffff;
      flex: none;
    }
    .act-num.secondary {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
    }
    h2 { margin: 0; font-size: 1.15rem; }
    h3 { margin: 0 0 0.5rem; font-size: 0.95rem; }
    p { margin: 0 0 0.9rem; font-size: 0.9rem; }
    .muted { color: var(--muted); }
    .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin: 1rem 0; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      min-height: 40px;
      padding: 0.55rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--fg);
      font: inherit;
      font-size: 0.85rem;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
    }
    .btn:hover { background: var(--accent); }
    .btn-primary {
      background: var(--primary);
      border-color: var(--primary);
      color: #ffffff;
    }
    .btn-primary:hover { filter: brightness(1.08); background: var(--primary); }
    .btn:disabled { opacity: 0.6; cursor: wait; }
    .walkthrough {
      border-left: 3px solid var(--border);
      padding-left: 1rem;
      margin: 1rem 0;
    }
    .walkthrough ol { margin: 0.35rem 0 0; padding-left: 1.25rem; font-size: 0.875rem; }
    .walkthrough li { margin-bottom: 0.35rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.1rem;
    }
    .inspector { position: sticky; top: 1.25rem; font-size: 0.82rem; }
    .inspector-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.9rem;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-weight: 700;
      color: var(--ok);
    }
    .status-badge.warn { color: var(--warn); }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; display: inline-block; }
    dl.kv { margin: 0; }
    dl.kv > div {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.45rem 0;
      border-bottom: 1px solid var(--border);
    }
    dl.kv > div:last-child { border-bottom: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; text-align: right; }
    .events {
      margin: 0.9rem 0 0;
      padding: 0.75rem 0 0;
      border-top: 1px solid var(--border);
    }
    .events ul {
      list-style: none;
      margin: 0.4rem 0 0;
      padding: 0;
      max-height: 180px;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      color: var(--muted);
    }
    .events li { padding: 0.25rem 0; border-bottom: 1px dashed var(--border); }
    .feedback {
      margin: 0.75rem 0;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--card);
      font-size: 0.85rem;
    }
    .feedback[hidden] { display: none; }
    dialog {
      max-width: min(880px, 92vw);
      width: 100%;
      max-height: 85vh;
      padding: 0;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--fg);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
    }
    dialog:modal { overscroll-behavior: contain; }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.55);
      overflow: hidden;
      overscroll-behavior: contain;
    }
    .dialog-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    .dialog-head h1 { font-size: 1.05rem; margin: 0; }
    .dialog-body { padding: 1.25rem; overflow-y: auto; max-height: 68vh; }
    .dialog-body pre {
      margin: 0 0 1.25rem;
      padding: 0.9rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--bg);
      overflow-x: auto;
      font-size: 0.78rem;
      line-height: 1.45;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    caption { text-align: left; font-weight: 700; margin-bottom: 0.5rem; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--border); }
    thead th { color: var(--muted); }
  </style>
</head>
<body>
  <a href="#main-content" class="skip-link visually-hidden">Skip to main content</a>
  <div id="live-announcer" aria-live="polite" aria-atomic="true" class="visually-hidden"></div>

  <div class="page-grid">
    <main id="main-content" tabindex="-1">
      <header class="page-header">
        <p class="eyebrow">Amazon EC2 Live Evaluation · Zero Local Docker Required</p>
        <h1>OpenPLC v4 + OIP Integration &amp; AI Cell Generator</h1>
        <p class="lead">Follow the guided steps below to verify both pre-assessment requirements directly from your browser. PLC logic executes inside Dockerized OpenPLC Runtime v4 on EC2; 3D physics renders natively on your browser GPU over our WebSocket-to-Modbus TCP bridge.</p>
      </header>

      <section class="act" aria-labelledby="act1-heading">
        <div class="act-head">
          <span class="act-num" aria-hidden="true">1</span>
          <h2 id="act1-heading">Act 1 — Operate Task 1: Live OpenPLC ↔ OIP Conveyor Cell</h2>
        </div>
        <p class="muted">Compiles Task 1's protected reference <code>conveyor-cell</code> Structured Text program with <code>STruC++</code>, deploys it over HTTPS to OpenPLC Runtime v4 Docker, and opens unmodified OIP in a dedicated full-viewport browser tab bridged to Modbus TCP port <code>5020</code>.</p>

        <div class="actions">
          <button type="button" id="btn-deploy-conveyor" class="btn btn-primary">Deploy conveyor-cell &amp; Launch OIP 3D ↗</button>
          <button type="button" id="btn-inspect-conveyor" class="btn">Inspect ST &amp; 11-Signal I/O Contract</button>
          <a id="link-open-conveyor" class="btn" href="/app/?cell=conveyor-cell" target="_blank" rel="noopener">Open OIP Tab Directly ↗</a>
        </div>

        <div id="act1-feedback" class="feedback" hidden></div>

        <div class="walkthrough">
          <h3>Operator Walkthrough (Inside OIP 3D Tab)</h3>
          <ol>
            <li>Click <strong>Play</strong> in OIP — External PLC Modbus TCP auto-connects on port <code>5020</code> via the pre-boot bridge (watch the live poll counter in the bottom-left status pill).</li>
            <li>Press <strong>START</strong> (<code>%IX0.0</code>) → green <code>Run_Light</code> illuminates, belt runs, and spawner dispenses spaced boxes.</li>
            <li>Watch each box reach the <strong>Photo-Eye</strong> (<code>%IX0.4</code>) → 2-second amber <strong>Inspection Dwell</strong> pauses motion and increments <code>Box_Count</code> (<code>%QW0</code>).</li>
            <li>After <strong>5 boxes</strong>, the <strong>Batch</strong> halts automatically until <strong>RESET</strong> (<code>%IX0.3</code>) is pressed while stopped.</li>
            <li>Toggle fail-safe NC <strong>E-STOP</strong> (<code>%IX0.2</code>) → belt and spawner drop immediately with red <code>Fault_Light</code>; releasing E-Stop never auto-restarts.</li>
          </ol>
        </div>
      </section>

      <section class="act" aria-labelledby="act2-heading">
        <div class="act-head">
          <span class="act-num secondary" aria-hidden="true">2</span>
          <h2 id="act2-heading">Act 2 — Run Task 2: Plain-English → OpenPLC + OIP Live</h2>
        </div>
        <div class="card">
          <p class="muted" style="margin:0">Live plain-English OpenCode Cell generation, Server-Sent Events streaming, and orchestration proof inspection will appear here once enabled.</p>
        </div>
      </section>

      <section class="act" aria-labelledby="act3-heading">
        <div class="act-head">
          <span class="act-num secondary" aria-hidden="true">3</span>
          <h2 id="act3-heading">Act 3 — Deploy Your AI-Generated Cell to OpenPLC &amp; 3D</h2>
        </div>
        <div class="card">
          <p class="muted" style="margin:0">Only Task 1's protected reference <code>conveyor-cell</code> ships on cold boot. Newly generated Cells will appear here with Inspect, Deploy &amp; Launch 3D, and Delete controls.</p>
        </div>
      </section>
    </main>

    <aside class="card inspector" aria-labelledby="runtime-heading">
      <div class="inspector-head">
        <h2 id="runtime-heading" style="font-size:0.95rem">Live EC2 Runtime</h2>
        <span id="rt-badge" class="status-badge"><span class="dot" aria-hidden="true"></span><span id="rt-status">CHECKING</span></span>
      </div>
      <dl class="kv">
        <div><dt>Active Cell</dt><dd id="rt-cell">—</dd></div>
        <div><dt>OpenPLC</dt><dd id="rt-version">—</dd></div>
        <div><dt>Modbus Polls</dt><dd id="rt-polls">0</dd></div>
        <div><dt>Bridge Lock</dt><dd id="rt-lock">Available</dd></div>
        <div><dt>Masters</dt><dd id="rt-masters">0</dd></div>
      </dl>
      <div class="events">
        <h3 style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted)">Recent Events</h3>
        <ul id="rt-events">
          <li>Waiting for telemetry…</li>
        </ul>
      </div>
    </aside>
  </div>

  <dialog id="inspector-dialog" closedby="any" aria-labelledby="inspector-title">
    <div class="dialog-head">
      <h1 id="inspector-title">Cell Inspector</h1>
      <form method="dialog">
        <button type="submit" class="btn" value="close" autofocus>Close</button>
      </form>
    </div>
    <div id="inspector-body" class="dialog-body"></div>
  </dialog>

  <script>
    const announcer = document.getElementById('live-announcer')
    const deployBtn = document.getElementById('btn-deploy-conveyor')
    const inspectBtn = document.getElementById('btn-inspect-conveyor')
    const feedbackEl = document.getElementById('act1-feedback')
    const dialog = document.getElementById('inspector-dialog')
    const dialogTitle = document.getElementById('inspector-title')
    const dialogBody = document.getElementById('inspector-body')

    function announce(message) {
      announcer.textContent = ''
      requestAnimationFrame(() => { announcer.textContent = message })
    }

    function setFeedback(text, launchUrl) {
      feedbackEl.hidden = false
      feedbackEl.textContent = ''
      const span = document.createElement('span')
      span.textContent = text
      feedbackEl.appendChild(span)
      if (launchUrl) {
        feedbackEl.appendChild(document.createTextNode(' '))
        const a = document.createElement('a')
        a.href = launchUrl
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = 'Open OIP 3D Tab ↗'
        feedbackEl.appendChild(a)
      }
    }

    async function refreshStatus() {
      try {
        const res = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const plc = data.openplc || {}
        const br = data.bridge || {}
        const leaseTotalMins = typeof br.leaseTimeoutMs === 'number'
          ? Math.max(1, Math.round(br.leaseTimeoutMs / 60000))
          : 30

        document.getElementById('rt-status').textContent = plc.plcStatus || 'OFFLINE'
        document.getElementById('rt-cell').textContent = plc.activeCell || 'none deployed'
        document.getElementById('rt-version').textContent = plc.version || 'Docker :8443'
        document.getElementById('rt-polls').textContent = String(br.polls ?? 0)
        document.getElementById('rt-masters').textContent = String(br.activeMasters ?? 0)

        const lockEl = document.getElementById('rt-lock')
        const badgeEl = document.getElementById('rt-badge')
        if (br.locked) {
          const mins = br.leaseRemainingMs != null ? Math.ceil(br.leaseRemainingMs / 60000) : leaseTotalMins
          lockEl.textContent = 'Locked (' + mins + 'm left)'
          badgeEl.className = 'status-badge'
        } else {
          lockEl.textContent = 'Available (' + leaseTotalMins + 'm)'
          badgeEl.className = plc.plcStatus === 'RUNNING' ? 'status-badge' : 'status-badge warn'
        }

        const eventsList = document.getElementById('rt-events')
        eventsList.textContent = ''
        const items = Array.isArray(data.events) && data.events.length > 0 ? data.events : ['Portal ready']
        for (const entry of items.slice(0, 8)) {
          const li = document.createElement('li')
          li.textContent = entry
          eventsList.appendChild(li)
        }
      } catch {
        // Ignore transient poll errors
      }
    }

    deployBtn.addEventListener('click', async () => {
      deployBtn.disabled = true
      setFeedback('Compiling STruC++ program and deploying conveyor-cell to OpenPLC Runtime v4…')
      try {
        const res = await fetch('/api/cells/conveyor-cell/deploy', {
          method: 'POST',
          credentials: 'same-origin',
        })
        const data = await res.json()
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Deployment failed (HTTP ' + res.status + ')')
        }
        setFeedback(
          'Deployed conveyor-cell to OpenPLC ' + data.version + ' (' + data.plcStatus + ').',
          data.launchUrl,
        )
        announce('Deployed conveyor-cell to OpenPLC Runtime v4.')
        void refreshStatus()
        window.open(data.launchUrl, '_blank', 'noopener')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setFeedback('Deployment error: ' + msg)
        announce('Deployment failed: ' + msg)
      } finally {
        deployBtn.disabled = false
      }
    })

    inspectBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/cells/conveyor-cell', { credentials: 'same-origin' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const data = await res.json()
        dialogTitle.textContent = 'Cell Inspector · scenes/' + data.slug + '/'
        dialogBody.textContent = ''

        const stHeading = document.createElement('h2')
        stHeading.textContent = 'Structured Text Program (plc/program.st)'
        stHeading.style.margin = '0 0 0.5rem'
        dialogBody.appendChild(stHeading)

        const pre = document.createElement('pre')
        pre.textContent = data.stSource || '(no ST program)'
        dialogBody.appendChild(pre)

        const signals = data.ioContract?.signals || []
        const table = document.createElement('table')
        const caption = document.createElement('caption')
        caption.textContent = 'Canonical I/O Contract (' + signals.length + ' signals)'
        table.appendChild(caption)

        const thead = document.createElement('thead')
        const headRow = document.createElement('tr')
        for (const col of ['Signal', 'IEC Address', 'Type', 'Direction', 'Modbus', 'Description']) {
          const th = document.createElement('th')
          th.scope = 'col'
          th.textContent = col
          headRow.appendChild(th)
        }
        thead.appendChild(headRow)
        table.appendChild(thead)

        const tbody = document.createElement('tbody')
        for (const sig of signals) {
          const tr = document.createElement('tr')
          const nameCell = document.createElement('th')
          nameCell.scope = 'row'
          nameCell.textContent = sig.name + (sig.contact ? ' (' + sig.contact + ')' : '')
          tr.appendChild(nameCell)
          const cells = [
            sig.iecAddress,
            sig.type,
            sig.direction === 'oip_to_plc' ? 'OIP → PLC' : 'PLC → OIP',
            sig.modbusArea + ' ' + sig.modbusAddress,
            sig.description || '',
          ]
          for (const val of cells) {
            const td = document.createElement('td')
            td.textContent = val
            tr.appendChild(td)
          }
          tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        dialogBody.appendChild(table)
        dialog.showModal()
      } catch (err) {
        setFeedback('Could not load Cell details: ' + (err instanceof Error ? err.message : String(err)))
      }
    })

    dialog.addEventListener('close', () => {
      dialog.returnValue = ''
    })

    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const outside = (e) => {
        const r = dialog.getBoundingClientRect()
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
      }
      let pressedOutside = false
      dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e) })
      dialog.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e)) dialog.close() })
    }

    void refreshStatus()
    window.setInterval(() => void refreshStatus(), 3000)
  </script>
</body>
</html>`
}
