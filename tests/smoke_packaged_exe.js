// Validates a relocated single EXE: desktop startup, launcher identity,
// origin/token gate, SFTP HTTP routing,
// DPAPI-backed credential persistence across a restart, native serialport
// enumeration and the VNC bridge upgrade path.  Everything runs against an
// isolated USERPROFILE so the developer's real sessions are never touched.
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'xterm.exe');
const PORT = Number(process.env.XTERM_SMOKE_PORT || 8903);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const sourceMode = process.env.XTERM_SMOKE_SOURCE === '1';
if (!sourceMode && !fs.existsSync(EXE)) throw new Error('dist/xterm.exe 不存在；请先运行 npm run build:exe');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
  });
}

async function waitForApp(processRun, deadline = Date.now() + 30000) {
  while (Date.now() < deadline) {
    if (processRun.child.exitCode !== null || processRun.child.signalCode !== null) {
      throw new Error(`Packaged engine exited during startup: ${processRun.output}`);
    }
    try {
      const res = await httpGet('/launcher-info');
      if (res.status === 200) return JSON.parse(res.body);
    } catch { /* not listening yet */ }
    await sleep(150);
  }
  throw new Error('packaged EXE did not start listening');
}

async function readToken() {
  const res = await httpGet('/bootstrap.js', { Origin: ORIGIN, Referer: `${ORIGIN}/` });
  assert.strictEqual(res.status, 200, 'bootstrap.js must be served to a trusted origin');
  const match = res.body.match(/__XTERM_TOKEN\s*=\s*"([^"]+)"/);
  assert(match, 'bootstrap token missing from packaged response');
  return match[1];
}

function nextMessage(ws, predicate, timeout = 15000, label = 'message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timed out`)); }, timeout);
    const handler = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'error') { cleanup(); reject(new Error(`${label}: ${message.msg}`)); return; }
      if (predicate(message)) { cleanup(); resolve(message); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}

async function openWs(pathname, token) {
  const sep = pathname.includes('?') ? '&' : '?';
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}${sep}token=${encodeURIComponent(token)}`, {
    headers: { Origin: ORIGIN },
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

// The bridge may close before an `open`-then-listen sequence would attach its
// close handler, so listen first and treat an early close as the result.
function expectWsClose(pathname, token, timeout = 15000) {
  const sep = pathname.includes('?') ? '&' : '?';
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}${sep}token=${encodeURIComponent(token)}`, {
    headers: { Origin: ORIGIN },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('VNC bridge did not close')); }, timeout);
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason || '') }); });
    ws.once('error', () => { /* close follows */ });
  });
}

function launch(executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, output: '' };
  child.stdout.on('data', chunk => { run.output += chunk; });
  child.stderr.on('data', chunk => { run.output += chunk; });
  run.done = new Promise(resolve => {
    child.once('error', error => {
      run.output += error.message;
      resolve(null);
    });
    child.once('close', resolve);
  });
  return run;
}

async function verifyDesktop(executable, cwd, env, proof) {
  const run = launch(executable, ['--port', String(PORT)], cwd, { ...env, XTERM_PROOF: proof });
  const timer = setTimeout(() => killTree(run.child), 90000);
  try {
    assert.strictEqual(await run.done, 0, run.output);
    assert.match(fs.readFileSync(proof, 'utf8'), /已连接|Server connected/);
    record('single EXE desktop connects from relocated folder with no Node on PATH');
  } finally {
    clearTimeout(timer);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await httpGet('/launcher-info'); } catch (error) {
      if (error.code === 'ECONNREFUSED') return;
      throw error;
    }
    await sleep(100);
  }
  throw new Error('Desktop exit did not shut down its engine');
}

async function startApp(executable, cwd, env) {
  const args = sourceMode ? ['server/index.js'] : [];
  const run = launch(executable, [...args, '--port', String(PORT), '--no-open'], cwd, env);
  try {
    const info = await waitForApp(run);
    assert.strictEqual(info.app, 'xterm', 'packaged launcher-info must identify xterm');
    assert.ok(Number.isInteger(info.pid), 'launcher-info must expose the real PID');
    const token = await readToken();
    const ws = await openWs('/', token);
    return { ...run, ws, token };
  } catch (error) {
    await stopApp(run);
    throw error;
  }
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill();
  }
}

async function stopApp(app) {
  if (!app) return;
  app.ws?.terminate();
  killTree(app.child);
  await app.done;
}
const checks = [];
function record(name) { checks.push(name); console.log(`   ✓ ${name}`); }

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-exe-smoke-'));
  const profile = path.join(sandbox, 'profile');
  const moved = path.join(sandbox, '独立目录 & offline');
  const cache = path.join(sandbox, 'temp');
  const executable = sourceMode ? process.execPath : path.join(moved, 'xterm.exe');
  const cwd = sourceMode ? ROOT : moved;
  const env = { ...process.env, USERPROFILE: profile, HOME: profile };
  let app = null;
  const sessionId = { value: '' };

  try {
    fs.mkdirSync(profile);
    if (sourceMode) {
      console.log('   (source mode: packaged artifact NOT validated)');
    } else {
      fs.mkdirSync(moved);
      fs.mkdirSync(cache);
      fs.copyFileSync(EXE, executable);
      for (const key of Object.keys(env)) {
        if (/^(path|node_path|node_options|xterm_node|xterm_proof|xterm_startup_request|xterm_rustdesk|electron_run_as_node|electron_override_dist_path)$/i.test(key)) delete env[key];
      }
      const system32 = path.join(process.env.SystemRoot, 'System32');
      Object.assign(env, {
        PATH: [system32, path.join(system32, 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
        TEMP: cache, TMP: cache,
        HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
        ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
        npm_config_offline: 'true',
      });
      await verifyDesktop(executable, cwd, env, path.join(sandbox, 'connected.txt'));
      assert.deepStrictEqual(fs.readdirSync(moved), ['xterm.exe']);
    }
    app = await startApp(executable, cwd, env);
    record('launcher identity + bootstrap token (isolated profile)');

    // ---------- static assets ----------
    const ui = await httpGet('/', { Origin: ORIGIN });
    assert.strictEqual(ui.status, 200, 'UI index must be served');
    assert(ui.body.includes('xterm'), 'UI page must identify the product');
    const vendor = await httpGet('/vendor/@xterm/xterm/lib/xterm.js', { Origin: ORIGIN });
    assert.strictEqual(vendor.status, 200, 'bundled xterm asset must be served from the package');
    record('web assets + bundled node_modules served');

    // ---------- security gate ----------
    const foreign = await httpGet('/bootstrap.js', { Origin: 'http://evil.example' });
    assert.strictEqual(foreign.status, 403, 'untrusted origin must not receive the token');
    const noToken = await httpGet('/api/sftp/download?conn=1&path=/tmp/x', { Origin: ORIGIN });
    assert.strictEqual(noToken.status, 403, 'API without token must be rejected');
    record('origin/token gate enforced inside the packaged build');

    // ---------- SFTP HTTP routing (module graph loaded) ----------
    const sftp = await httpGet(`/api/sftp/download?conn=1&path=/tmp/x&token=${encodeURIComponent(app.token)}`, { Origin: ORIGIN });
    assert.strictEqual(sftp.status, 400, 'SFTP route must answer without a live connection');
    assert(sftp.body.includes('SFTP'), `SFTP handler answered unexpectedly: ${sftp.body}`);
    record('SFTP HTTP handler + ssh2/archiver module graph loaded');

    // ---------- sessions over WS ----------
    let response = nextMessage(app.ws, (m) => m.type === 'sessions', 15000, 'session list');
    app.ws.send(JSON.stringify({ type: 'list' }));
    assert(Array.isArray((await response).list), 'session list must be an array');
    record('WebSocket JSON routing + sessions store');

    // ---------- native serialport binding ----------
    response = nextMessage(app.ws, (m) => m.type === 'serialports', 20000, 'serialport enumeration');
    app.ws.send(JSON.stringify({ type: 'serialports' }));
    const ports = (await response).list;
    assert(Array.isArray(ports), 'serialport enumeration must return a list');
    record(`native serialport binding works (${ports.length} port(s) detected)`);

    if (!sourceMode) {
      response = nextMessage(app.ws, (m) => m.type === 'rustdesk-info', 15000, 'bundled RustDesk detection');
      app.ws.send(JSON.stringify({ type: 'rustdesk-info' }));
      const { clientPath } = await response;
      assert(path.relative(cache, clientPath).startsWith('caxa' + path.sep), 'RustDesk must resolve from the extracted EXE');
      assert(clientPath.endsWith(path.join('tools', 'rustdesk', 'rustdesk.exe')));
      record('bundled RustDesk resolves inside the extracted runtime');
    }

    // ---------- VNC bridge policy ----------
    // A public target must be refused by the bridge's private-target policy,
    // which proves the VNC module and its validation ran inside the package.
    const vncClose = await expectWsClose('/vnc?host=8.8.8.8&port=5901', app.token);
    assert.strictEqual(vncClose.code, 1008, `VNC bridge must enforce its policy, got ${vncClose.code}`);
    assert(vncClose.reason.includes('私网'), `unexpected VNC close reason: ${vncClose.reason}`);
    record('VNC bridge upgrade path + private-target policy');

    // ---------- DPAPI write ----------
    const vncPassword = `exe-smoke-vnc-密码-${Date.now()}`;
    response = nextMessage(app.ws, (m) => m.type === 'session-saved', 15000, 'session save');
    app.ws.send(JSON.stringify({
      type: 'save', requestId: 'exe-smoke-vnc', session: {
        name: 'exe-smoke-vnc', type: 'vnc', host: '127.0.0.1', port: 5901,
        password: vncPassword, rememberPassword: true, reconnect: true,
      },
    }));
    sessionId.value = (await response).id;
    const secretsPath = path.join(profile, '.xterm', 'secrets.enc');
    assert(fs.existsSync(secretsPath), 'DPAPI secrets file must be written by the packaged build');
    assert(!fs.readFileSync(secretsPath, 'utf8').includes(vncPassword),
      'DPAPI-protected secrets must not contain plaintext');
    response = nextMessage(app.ws, (m) => m.type === 'sessions', 15000, 'session list');
    app.ws.send(JSON.stringify({ type: 'list' }));
    const listed = (await response).list.find((item) => item.id === sessionId.value);
    assert(listed, 'saved session must be listed');
    assert.strictEqual(listed.password, undefined, 'session list must never expose the password');
    record('DPAPI credential write + list sanitization');

    // ---------- DPAPI read after restart ----------
    await stopApp(app);
    app = await startApp(executable, cwd, env);
    response = nextMessage(app.ws, (m) => m.type === 'vnc-credential' && m.requestId === 'exe-smoke-restore',
      20000, 'vnc credential');
    app.ws.send(JSON.stringify({
      type: 'vnc-credential', requestId: 'exe-smoke-restore',
      session: { id: sessionId.value, type: 'vnc', host: '127.0.0.1', port: 5901 },
    }));
    assert.strictEqual((await response).password, vncPassword,
      'DPAPI must decrypt the remembered credential after a packaged restart');
    record('DPAPI credential read after packaged restart');

    console.log(`\n✅ packaged EXE full smoke test passed (${checks.length} checks)`);
  } finally {
    await stopApp(app);
    assert.strictEqual(path.dirname(sandbox), os.tmpdir());
    assert(path.basename(sandbox).startsWith('xterm-exe-smoke-'));
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((error) => { console.error('❌', error.stack || error.message); process.exit(1); });

