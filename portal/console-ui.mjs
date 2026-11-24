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
      --danger-light: #dc2626;
      --danger-dark: #f87171;

      --bg: var(--bg-light);
      --card: var(--card-light);
      --fg: var(--fg-light);
      --muted: var(--muted-light);
      --border: var(--border-light);
      --primary: var(--primary-light);
      --accent: var(--accent-light);
      --ok: var(--ok-light);
      --warn: var(--warn-light);
      --danger: var(--danger-light);
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
        --danger: var(--danger-dark);
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
        --danger: light-dark(var(--danger-light), var(--danger-dark));
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
    .form-field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.9rem; }
    .form-field label { font-size: 0.85rem; font-weight: 600; }
    .form-hint { font-size: 0.78rem; color: var(--muted); }
    .form-field input, .form-field textarea {
      width: 100%;
      font: inherit;
      font-size: max(1rem, 1em);
      min-height: 44px;
      padding: 0.6rem 0.75rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
    }
    .form-field textarea { min-height: 92px; resize: vertical; }
    .preset-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.9rem; }
    .btn-chip {
      min-height: 34px;
      padding: 0.3rem 0.7rem;
      font-size: 0.78rem;
      border-radius: 999px;
    }
    .btn-danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    .pipeline-panel {
      margin-top: 1rem;
      padding: 0.9rem;
      border-radius: 0.65rem;
      border: 1px solid var(--border);
      background: var(--bg);
    }
    .pipeline-panel progress {
      width: 100%;
      height: 10px;
      accent-color: var(--primary);
      margin-bottom: 0.65rem;
    }
    .stage-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.45rem;
      margin-bottom: 0.75rem;
    }
    @media (max-width: 640px) {
      .stage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    .stage-pill {
      font-size: 0.75rem;
      padding: 0.4rem 0.55rem;
      border-radius: 0.45rem;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--muted);
    }
    .stage-pill[data-state="active"] {
      border-color: var(--primary);
      color: var(--fg);
      font-weight: 600;
    }
    .stage-pill[data-state="done"] {
      border-color: var(--ok);
      color: var(--ok);
      font-weight: 600;
    }
    .stage-pill[data-state="error"] {
      border-color: var(--danger);
      color: var(--danger);
    }
    .gen-log {
      margin: 0;
      padding: 0.65rem 0.75rem;
      max-height: 180px;
      overflow-y: auto;
      border-radius: 0.45rem;
      border: 1px solid var(--border);
      background: var(--card);
      font-size: 0.75rem;
      line-height: 1.45;
      color: var(--muted);
      white-space: pre-wrap;
    }
    .cell-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .cell-card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.9rem 1rem;
      border-radius: 0.65rem;
      border: 1px solid var(--border);
      background: var(--card);
    }
    .cell-meta { min-width: 200px; flex: 1; }
    .cell-meta h3 { margin: 0 0 0.2rem; font-size: 0.95rem; }
    .cell-meta p { margin: 0; font-size: 0.8rem; color: var(--muted); }
    .cell-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
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
          <span class="act-num" aria-hidden="true">2</span>
          <h2 id="act2-heading">Act 2 — Run Task 2: Plain-English → OpenPLC + OIP Live</h2>
        </div>
        <p class="muted">Describe a new industrial Cell in plain English. OpenCode's orchestrator synthesizes a canonical <strong>I/O Contract</strong>, fans out three specialist agents (<code>plc-coder</code>, <code>oip-builder</code>, <code>test-engineer</code>) across parallel <code>git worktree</code> branches, merges them, and runs 3-gate verification before persisting the Cell.</p>

        <div class="card">
          <div class="preset-row" role="group" aria-label="Example prompts">
            <button type="button" class="btn btn-chip" data-preset-name="batch-counter" data-preset-prompt="A belt conveyor with a spawner, start/stop/reset/E-stop buttons, and a Photo-Eye that pauses each box for 2 seconds and stops the batch after 4 boxes until reset.">Preset: 4-Box Inspection Batch</button>
            <button type="button" class="btn btn-chip" data-preset-name="diverter-gate" data-preset-prompt="A conveyor cell with a box spawner, start/stop/E-stop controls, a Photo-Eye, and a pneumatic pusher that diverts every second box onto a side chute while counting total items.">Preset: Alternating Diverter</button>
          </div>

          <form id="generate-form">
            <div class="form-field">
              <label for="prompt-input">Plain-English Cell Description</label>
              <span id="prompt-hint" class="form-hint">Describe parts, inputs, actuators, and operating rules. Single-flight lock + daily quota protect EC2 compute.</span>
              <textarea id="prompt-input" name="prompt" required maxlength="2000" aria-describedby="prompt-hint" placeholder="Example: Build a conveyor cell with Start, Stop, Reset, NC E-Stop, a Photo-Eye, and a 3-box batch counter..."></textarea>
            </div>

            <div class="form-field">
              <label for="cell-name-input">Optional Cell Slug</label>
              <span id="cell-name-hint" class="form-hint">Lowercase letters, digits, hyphens, or underscores. Leave blank to derive automatically.</span>
              <input id="cell-name-input" name="name" type="text" pattern="[a-z0-9][a-z0-9_-]{0,47}" aria-describedby="cell-name-hint" placeholder="e.g. inspection-sorter" />
            </div>

            <div class="actions" style="margin-bottom:0">
              <button type="submit" id="btn-generate" class="btn btn-primary">Generate Cell with OpenCode Agents</button>
              <button type="button" id="btn-view-proof" class="btn">View Committed Orchestration Proof</button>
            </div>
          </form>

          <div id="act2-feedback" class="feedback" hidden></div>

          <div class="pipeline-panel">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;margin-bottom:0.45rem;font-size:0.8rem">
              <strong id="gen-stage-label" aria-live="polite">Pipeline idle</strong>
              <span id="gen-model-label" class="muted">4 stages · parallel git worktrees</span>
            </div>
            <progress id="gen-progress" max="4" value="0" aria-labelledby="gen-stage-label">0%</progress>
            <div class="stage-grid">
              <div class="stage-pill" data-stage="stage1" data-state="idle">1. I/O Contract</div>
              <div class="stage-pill" data-stage="stage2" data-state="idle">2. 3 Worktrees</div>
              <div class="stage-pill" data-stage="stage3" data-state="idle">3. Merge</div>
              <div class="stage-pill" data-stage="stage4" data-state="idle">4. 3-Gate Verify</div>
            </div>
            <pre id="gen-log" class="gen-log">Live Server-Sent Events log ready. Submit a prompt above or inspect the committed proof report.</pre>
          </div>
        </div>
      </section>

      <section class="act" aria-labelledby="act3-heading">
        <div class="act-head">
          <span class="act-num" aria-hidden="true">3</span>
          <h2 id="act3-heading">Act 3 — Deploy Your AI-Generated Cell to OpenPLC &amp; 3D</h2>
        </div>
        <p class="muted">Generated Cells persist on EC2's volume across restarts without modifying the git repository. Inspect the generated Structured Text and verification report, deploy directly into OpenPLC Runtime v4, or delete when finished.</p>
        <div id="act3-feedback" class="feedback" hidden></div>
        <div id="generated-cells-list" class="cell-list">
          <div class="card">
            <p class="muted" style="margin:0">No AI-generated Cells yet. Run Act 2 above to generate your first Cell — only Task 1's protected reference <code>conveyor-cell</code> ships on cold boot.</p>
          </div>
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
        <div><dt>AI Quota</dt><dd id="rt-quota">0 / 10</dd></div>
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
    const act2FeedbackEl = document.getElementById('act2-feedback')
    const act3FeedbackEl = document.getElementById('act3-feedback')
    const generateForm = document.getElementById('generate-form')
    const promptInput = document.getElementById('prompt-input')
    const nameInput = document.getElementById('cell-name-input')
    const generateBtn = document.getElementById('btn-generate')
    const proofBtn = document.getElementById('btn-view-proof')
    const genProgress = document.getElementById('gen-progress')
    const genStageLabel = document.getElementById('gen-stage-label')
    const genModelLabel = document.getElementById('gen-model-label')
    const genLogEl = document.getElementById('gen-log')
    const cellsListEl = document.getElementById('generated-cells-list')
    const dialog = document.getElementById('inspector-dialog')
    const dialogTitle = document.getElementById('inspector-title')
    const dialogBody = document.getElementById('inspector-body')

    const STAGE_ORDER = ['stage1', 'stage2', 'stage3', 'stage4']
    const STAGE_LABELS = {
      queued: 'Queued · Preparing OpenCode workspace…',
      preflight: 'Preflight · Checking model availability…',
      stage1: 'Stage 1/4 · Orchestrator synthesizing I/O Contract',
      stage2: 'Stage 2/4 · 3 specialist agents running in parallel git worktrees',
      stage3: 'Stage 3/4 · Merging worker branches into integration worktree',
      stage4: 'Stage 4/4 · Running 3 deterministic verification gates',
      stage4_repair: 'Stage 4/4 · Running targeted orchestrator repair pass',
    }

    function announce(message) {
      announcer.textContent = ''
      requestAnimationFrame(() => { announcer.textContent = message })
    }

    function setBoxFeedback(el, text, launchUrl) {
      el.hidden = false
      el.textContent = ''
      const span = document.createElement('span')
      span.textContent = text
      el.appendChild(span)
      if (launchUrl) {
        el.appendChild(document.createTextNode(' '))
        const a = document.createElement('a')
        a.href = launchUrl
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = 'Open OIP 3D Tab ↗'
        el.appendChild(a)
      }
    }

    function setFeedback(text, launchUrl) {
      setBoxFeedback(feedbackEl, text, launchUrl)
    }

    function updateQuota(quota) {
      if (!quota) return
      const el = document.getElementById('rt-quota')
      if (el) el.textContent = String(quota.used ?? 0) + ' / ' + String(quota.cap ?? 10)
    }

    function setPipelineStage(stage, model, stateOverride) {
      const normalizedStage = stage === 'stage4_repair' ? 'stage4' : stage
      const idx = STAGE_ORDER.indexOf(normalizedStage)
      if (stateOverride === 'done') {
        genProgress.value = 4
        genStageLabel.textContent = 'Generation complete'
      } else if (stateOverride === 'error') {
        genStageLabel.textContent = 'Generation failed'
      } else if (stage) {
        genProgress.value = idx >= 0 ? idx + 1 : 0.25
        genStageLabel.textContent = STAGE_LABELS[stage] || ('Running · ' + stage)
      } else {
        genProgress.value = 0
        genStageLabel.textContent = 'Pipeline idle'
      }

      if (model) {
        genModelLabel.textContent = 'Model: ' + model
      }

      const pills = document.querySelectorAll('.stage-pill')
      for (const pill of pills) {
        const pillStage = pill.getAttribute('data-stage')
        const pillIdx = STAGE_ORDER.indexOf(pillStage)
        if (stateOverride === 'done') {
          pill.setAttribute('data-state', 'done')
        } else if (stateOverride === 'error') {
          pill.setAttribute('data-state', pillIdx === idx ? 'error' : pillIdx < idx ? 'done' : 'idle')
        } else if (idx >= 0) {
          pill.setAttribute('data-state', pillIdx < idx ? 'done' : pillIdx === idx ? 'active' : 'idle')
        } else {
          pill.setAttribute('data-state', 'idle')
        }
      }
    }

    function appendGenLog(line, reset) {
      if (reset) {
        genLogEl.textContent = line
      } else {
        genLogEl.textContent = (genLogEl.textContent ? genLogEl.textContent + '\n' : '') + line
      }
      genLogEl.scrollTop = genLogEl.scrollHeight
    }

    async function deployCell(slug, targetFeedback, triggerBtn) {
      if (triggerBtn) triggerBtn.disabled = true
      setBoxFeedback(targetFeedback, 'Compiling STruC++ program and deploying ' + slug + ' to OpenPLC Runtime v4…')
      try {
        const res = await fetch('/api/cells/' + encodeURIComponent(slug) + '/deploy', {
          method: 'POST',
          credentials: 'same-origin',
        })
        const data = await res.json()
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Deployment failed (HTTP ' + res.status + ')')
        }
        setBoxFeedback(
          targetFeedback,
          'Deployed ' + slug + ' to OpenPLC ' + data.version + ' (' + data.plcStatus + ').',
          data.launchUrl,
        )
        announce('Deployed ' + slug + ' to OpenPLC Runtime v4.')
        void refreshStatus()
        window.open(data.launchUrl, '_blank', 'noopener')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setBoxFeedback(targetFeedback, 'Deployment error: ' + msg)
        announce('Deployment failed: ' + msg)
      } finally {
        if (triggerBtn) triggerBtn.disabled = false
      }
    }

    async function inspectCell(slug, targetFeedback) {
      try {
        const res = await fetch('/api/cells/' + encodeURIComponent(slug), { credentials: 'same-origin' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const data = await res.json()
        dialogTitle.textContent = 'Cell Inspector · scenes/' + data.slug + '/'
        dialogBody.textContent = ''

        if (data.generationReport) {
          const repHeading = document.createElement('h2')
          repHeading.textContent = 'Generation & Verification Summary'
          repHeading.style.margin = '0 0 0.5rem'
          dialogBody.appendChild(repHeading)

          const repPre = document.createElement('pre')
          repPre.textContent = JSON.stringify(data.generationReport, null, 2)
          dialogBody.appendChild(repPre)
        }

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
        setBoxFeedback(
          targetFeedback,
          'Could not load Cell details: ' + (err instanceof Error ? err.message : String(err)),
        )
      }
    }

    async function refreshCells() {
      try {
        const res = await fetch('/api/cells', { credentials: 'same-origin', cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const generated = (data.cells || []).filter((c) => !c.protected)
        cellsListEl.textContent = ''

        if (generated.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'card'
          const p = document.createElement('p')
          p.className = 'muted'
          p.style.margin = '0'
          p.textContent = 'No AI-generated Cells yet. Run Act 2 above to generate your first Cell — only Task 1\u2019s protected reference conveyor-cell ships on cold boot.'
          empty.appendChild(p)
          cellsListEl.appendChild(empty)
          return
        }

        for (const cell of generated) {
          const card = document.createElement('article')
          card.className = 'cell-card'

          const meta = document.createElement('div')
          meta.className = 'cell-meta'
          const title = document.createElement('h3')
          title.textContent = cell.slug
          meta.appendChild(title)

          const desc = document.createElement('p')
          const parts = [cell.signalCount + ' signals']
          if (cell.capturedAt) parts.push('Generated ' + cell.capturedAt.slice(0, 19).replace('T', ' ') + ' UTC')
          desc.textContent = parts.join(' · ')
          meta.appendChild(desc)
          card.appendChild(meta)

          const actions = document.createElement('div')
          actions.className = 'cell-actions'

          const deployCellBtn = document.createElement('button')
          deployCellBtn.type = 'button'
          deployCellBtn.className = 'btn btn-primary'
          deployCellBtn.textContent = 'Deploy & Launch 3D ↗'
          deployCellBtn.addEventListener('click', () => void deployCell(cell.slug, act3FeedbackEl, deployCellBtn))
          actions.appendChild(deployCellBtn)

          const inspectCellBtn = document.createElement('button')
          inspectCellBtn.type = 'button'
          inspectCellBtn.className = 'btn'
          inspectCellBtn.textContent = 'Inspect ST & Report'
          inspectCellBtn.addEventListener('click', () => void inspectCell(cell.slug, act3FeedbackEl))
          actions.appendChild(inspectCellBtn)

          const deleteCellBtn = document.createElement('button')
          deleteCellBtn.type = 'button'
          deleteCellBtn.className = 'btn btn-danger'
          deleteCellBtn.textContent = 'Delete'
          deleteCellBtn.addEventListener('click', async () => {
            if (!window.confirm('Delete generated Cell "' + cell.slug + '"?')) return
            deleteCellBtn.disabled = true
            try {
              const delRes = await fetch('/api/cells/' + encodeURIComponent(cell.slug), {
                method: 'DELETE',
                credentials: 'same-origin',
              })
              const delData = await delRes.json()
              if (!delRes.ok || !delData.ok) {
                throw new Error(delData.error || 'Delete failed (HTTP ' + delRes.status + ')')
              }
              setBoxFeedback(act3FeedbackEl, 'Deleted generated Cell "' + cell.slug + '".')
              announce('Deleted Cell ' + cell.slug)
              void refreshCells()
              void refreshStatus()
            } catch (err) {
              setBoxFeedback(
                act3FeedbackEl,
                'Delete error: ' + (err instanceof Error ? err.message : String(err)),
              )
            } finally {
              deleteCellBtn.disabled = false
            }
          })
          actions.appendChild(deleteCellBtn)

          card.appendChild(actions)
          cellsListEl.appendChild(card)
        }
      } catch {
        // Ignore transient fetch errors
      }
    }

    async function refreshStatus() {
      try {
        const res = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const plc = data.openplc || {}
        const br = data.bridge || {}
        const gen = data.generation || {}
        const leaseTotalMins = typeof br.leaseTimeoutMs === 'number'
          ? Math.max(1, Math.round(br.leaseTimeoutMs / 60000))
          : 30

        document.getElementById('rt-status').textContent = plc.plcStatus || 'OFFLINE'
        document.getElementById('rt-cell').textContent = plc.activeCell || 'none deployed'
        document.getElementById('rt-version').textContent = plc.version || 'Docker :8443'
        document.getElementById('rt-polls').textContent = String(br.polls ?? 0)
        document.getElementById('rt-masters').textContent = String(br.activeMasters ?? 0)
        updateQuota(gen.quota)
        generateBtn.disabled = Boolean(gen.running)

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

    deployBtn.addEventListener('click', () => void deployCell('conveyor-cell', feedbackEl, deployBtn))
    inspectBtn.addEventListener('click', () => void inspectCell('conveyor-cell', feedbackEl))

    for (const chip of document.querySelectorAll('[data-preset-prompt]')) {
      chip.addEventListener('click', () => {
        promptInput.value = chip.getAttribute('data-preset-prompt') || ''
        nameInput.value = chip.getAttribute('data-preset-name') || ''
        promptInput.focus()
      })
    }

    generateForm.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const prompt = promptInput.value.trim()
      const name = nameInput.value.trim()
      if (!prompt) return
      generateBtn.disabled = true
      setBoxFeedback(act2FeedbackEl, 'Submitting plain-English specification to OpenCode orchestrator…')
      appendGenLog('[' + new Date().toISOString().slice(11, 19) + '] Starting OpenCode multi-agent pipeline…', true)
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, name: name || undefined }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Generation rejected (HTTP ' + res.status + ')')
        }
        updateQuota(data.quota)
        setBoxFeedback(act2FeedbackEl, 'Generating Cell "' + data.slug + '" — streaming live progress below.')
        announce('Started AI Cell generation for ' + data.slug)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setBoxFeedback(act2FeedbackEl, 'Could not start generation: ' + msg)
        announce('Generation failed to start: ' + msg)
        generateBtn.disabled = false
      }
    })

    proofBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/proof', { credentials: 'same-origin' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const data = await res.json()
        dialogTitle.textContent = 'Committed Task 2 Orchestration Proof'
        dialogBody.textContent = ''
        const pre = document.createElement('pre')
        pre.textContent = data.markdown || JSON.stringify(data.json, null, 2)
        dialogBody.appendChild(pre)
        dialog.showModal()
      } catch (err) {
        setBoxFeedback(
          act2FeedbackEl,
          'Could not load orchestration proof: ' + (err instanceof Error ? err.message : String(err)),
        )
      }
    })

    const eventSource = new EventSource('/api/generate/events')
    eventSource.addEventListener('snapshot', (ev) => {
      try {
        const snap = JSON.parse(ev.data)
        updateQuota(snap.quota)
        generateBtn.disabled = Boolean(snap.running)
        if (snap.activeJob) {
          setPipelineStage(snap.activeJob.stage, snap.activeJob.model)
          if (Array.isArray(snap.activeJob.logs) && snap.activeJob.logs.length > 0) {
            appendGenLog(snap.activeJob.logs.join('\n'), true)
          }
        }
      } catch {
        // Ignore malformed snapshot
      }
    })
    eventSource.addEventListener('stage', (ev) => {
      try {
        const data = JSON.parse(ev.data)
        updateQuota(data.quota)
        generateBtn.disabled = true
        setPipelineStage(data.stage, data.model)
        appendGenLog('[' + (data.ts || '').slice(11, 19) + '] Stage: ' + data.stage + (data.model ? ' (' + data.model + ')' : ''))
      } catch {
        // Ignore malformed stage event
      }
    })
    eventSource.addEventListener('log', (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.line) appendGenLog(data.line)
      } catch {
        // Ignore malformed log event
      }
    })
    eventSource.addEventListener('done', (ev) => {
      try {
        const data = JSON.parse(ev.data)
        updateQuota(data.quota)
        generateBtn.disabled = false
        setPipelineStage('stage4', null, 'done')
        setBoxFeedback(
          act2FeedbackEl,
          'Generated Cell "' + data.slug + '" passed all 3 verification gates and is ready in Act 3 below.',
        )
        announce('Cell ' + data.slug + ' generation complete.')
        void refreshCells()
        void refreshStatus()
      } catch {
        // Ignore malformed done event
      }
    })
    eventSource.addEventListener('error', (ev) => {
      if (!ev.data) return
      try {
        const data = JSON.parse(ev.data)
        updateQuota(data.quota)
        generateBtn.disabled = false
        setPipelineStage(data.stage || null, null, 'error')
        setBoxFeedback(act2FeedbackEl, 'Generation failed for "' + data.slug + '": ' + (data.error || 'Unknown error'))
        announce('Cell generation failed.')
        void refreshStatus()
      } catch {
        // Ignore transient SSE reconnect error
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

    void refreshCells()
    void refreshStatus()
    window.setInterval(() => void refreshStatus(), 3000)
  </script>
</body>
</html>`
}
