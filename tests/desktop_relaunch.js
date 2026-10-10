'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-desktop-relaunch-'));
const project = path.join(sandbox, '中文 目录 & app');
const profile = path.join(sandbox, 'profile');
const env = { ...process.env, USERPROFILE: profile, HOME: profile, XTERM_TEST_NO_DIALOG: '1' };
for (const key of ['XTERM_PROOF', 'XTERM_STARTUP_REQUEST', 'ELECTRON_RUN_AS_NODE']) delete env[key];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownedDesktops = new Set();
let completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('Desktop verification did not complete'); process.exitCode = 1; } });

function run(args, vbs = false) {
  return new Promise((resolve, reject) => {
    const command = vbs ? 'cscript.exe' : process.execPath;
    const parameters = vbs ? ['//nologo', path.join(project, 'launcher.vbs'), ...args]
      : [path.join(project, 'scripts', 'launch.js'), ...args];
    const child = spawn(command, parameters, { env, cwd: sandbox, windowsHide: true });
    child.stdin.end();
    let output = '';
    child.stdout.on('data', b => output += b);
    child.stderr.on('data', b => output += b);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Launcher timed out: ${output}`)); }, 95000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, output });
    });
  });
}
function info(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/launcher-info`, res => {
      let body = ''; res.on('data', b => body += b); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('Health request timed out')));
  });
}
async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
function desktopPids() {
  const log = path.join(profile, '.xterm', 'logs', 'launcher.log');
  if (fs.existsSync(log)) {
    for (const match of fs.readFileSync(log, 'utf8').matchAll(/desktop PID (\d+)/g)) ownedDesktops.add(Number(match[1]));
  }
  const desktopLog = path.join(profile, '.xterm', 'logs', 'desktop.log');
  if (fs.existsSync(desktopLog)) {
    for (const match of fs.readFileSync(desktopLog, 'utf8').matchAll(/\[(\d+)\] Single instance lock: true/g)) ownedDesktops.add(Number(match[1]));
  }
}
async function stopDesktop(pid) {
  assert(ownedDesktops.has(pid), 'stop only a desktop identified by this test profile');
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill(pid);
  ownedDesktops.delete(pid); await sleep(700);
}

(async () => {
  try {
    fs.mkdirSync(project); fs.mkdirSync(profile);
    for (const directory of ['desktop', 'scripts', 'server', 'web', 'node_modules']) {
      fs.cpSync(path.join(root, directory), path.join(project, directory), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(project, 'package.json'));
    for (const file of ['launcher.vbs', 'launch.ps1', 'run.bat', '启动.cmd']) fs.copyFileSync(path.join(root, file), path.join(project, file));
    const port = await freePort();
    // True concurrent cold starts: no XTERM_PROOF that auto-quits the first app.
    const cold = await Promise.all(Array.from({ length: 3 }, () => run(['--port', String(port)])));
    cold.forEach(result => assert.strictEqual(result.code, 0, result.output));
    desktopPids();
    assert.strictEqual(ownedDesktops.size, 1, 'all concurrent launches must report the same desktop');
    const server = await info(port);
    console.log('✓ Three simultaneous cold launches reached the same connected desktop');
    for (let i = 0; i < 5; i++) {
      const result = await run(['--port', String(port)]);
      assert.strictEqual(result.code, 0, result.output);
      assert.strictEqual((await info(port)).pid, server.pid, 'relaunch replaced the active engine');
    }
    desktopPids(); assert.strictEqual(ownedDesktops.size, 1);
    assert(!fs.existsSync(path.join(project, '--allow-file-access-from-files')), 'readiness must never be written to a Chromium switch');
    console.log('✓ Five repeated launches preserved the engine and returned valid confirmations');
    if (process.platform === 'win32') {
      const scripts = await Promise.all([run(['--port', String(port)], true), run(['--port', String(port)], true)]);
      scripts.forEach(result => assert.strictEqual(result.code, 0, result.output));
      assert.strictEqual((await info(port)).pid, server.pid, 'VBS relaunch replaced active sessions');
      desktopPids(); assert.strictEqual(ownedDesktops.size, 1);
      console.log('✓ Actual VBS double-click entry launched twice against the persistent desktop');
    }
    const differentPort = await freePort();
    assert.strictEqual((await run(['--port', String(differentPort)])).code, 0);
    assert.strictEqual((await info(port)).pid, server.pid, 'existing desktop must report its actual port');
    desktopPids();
    await stopDesktop([...ownedDesktops][0]);
    const restarted = await run(['--port', String(port)]);
    assert.strictEqual(restarted.code, 0, restarted.output);
    assert.notStrictEqual((await info(port)).pid, server.pid);
    desktopPids();
    console.log('✓ Existing-port reuse and restart after desktop termination passed');
    completed = true;
    console.log('Real Electron desktop launch/relaunch verification passed');
  } finally {
    desktopPids();
    for (const pid of [...ownedDesktops]) await stopDesktop(pid);
    assert.strictEqual(path.dirname(sandbox), os.tmpdir());
    assert(path.basename(sandbox).startsWith('xterm-desktop-relaunch-'));
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
