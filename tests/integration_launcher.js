'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-launch-'));
const moved = path.join(sandbox, '移动 项目 & portable');
const profile = path.join(sandbox, 'profile');
const env = { ...process.env, USERPROFILE: profile, HOME: profile };
const owned = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function request(port, route = '/launcher-info') {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${route}`, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.setTimeout(1000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: sandbox, env, windowsHide: true, ...options });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`launcher timed out: ${output}`)); }, 20000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    // Windows may retain inherited pipe handles in a detached descendant.
    // Process exit is the lifecycle contract; do not wait for descendant EOF.
    child.on('exit', code => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, output });
    });
  });
}

async function stop(port) {
  const info = JSON.parse(await request(port));
  assert(owned.has(info.pid), 'only test-owned servers may be stopped');
  process.kill(info.pid);
  for (let i = 0; i < 40; i++) {
    try { await request(port); } catch { owned.delete(info.pid); return; }
    await sleep(50);
  }
  throw new Error('test server did not stop');
}

async function exercise(command, args, options) {
  const port = await freePort();
  const result = await run(command, args(port), options);
  const errorLog = path.join(profile, '.xterm', 'logs', 'server-stderr.log');
  assert.strictEqual(result.code, 0, result.output + (fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : ''));
  const info = JSON.parse(await request(port));
  owned.add(info.pid);
  // The launcher has exited; the server must still be reachable afterward.
  await sleep(350);
  assert.strictEqual(JSON.parse(await request(port)).pid, info.pid);
  return { port, info };
}

(async () => {
  let foreign;
  try {
    for (const dir of ['scripts', 'server', 'node_modules']) fs.mkdirSync(path.join(moved, dir), { recursive: true });
    fs.mkdirSync(profile);
    for (const file of ['scripts/launch.js', 'scripts/dependencies.js', 'scripts/bootstrap-node.ps1', 'server/open-browser.js', 'launch.ps1', 'run.bat', 'run.sh']) {
      fs.copyFileSync(path.join(root, file), path.join(moved, file));
    }
    copyDirectory(path.dirname(require.resolve('ws/package.json')), path.join(moved, 'node_modules', 'ws'));
    fs.writeFileSync(path.join(moved, 'package.json'), JSON.stringify({ dependencies: { ws: '*' } }));
    fs.writeFileSync(path.join(moved, 'server', 'index.js'), `
      const http = require('http');
      const { WebSocketServer } = require('ws');
      const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
      const server = http.createServer((req, res) => {
        if (req.url === '/bootstrap.js') return res.end('window.__XTERM_TOKEN="fixture";');
        res.end(JSON.stringify({ app: 'xterm', pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }));
      });
      new WebSocketServer({ server }).on('connection', ws => {
        ws.on('message', () => ws.send(JSON.stringify({ type: 'sessions', list: [] })));
      });
      server.listen(port, '127.0.0.1');
    `);

    const launcher = path.join(moved, 'scripts', 'launch.js');
    const nodeArgs = port => [launcher, '--no-open', '--port', String(port)];
    const first = await exercise(process.execPath, nodeArgs);
    assert.strictEqual(fs.realpathSync(first.info.cwd), fs.realpathSync(moved));
    assert(first.info.args.includes('--no-open'));
    fs.appendFileSync(path.join(moved, 'server', 'index.js'), '\n// source updated\n');
    const reused = await run(process.execPath, nodeArgs(first.port));
    assert.strictEqual(reused.code, 0, reused.output);
    assert.strictEqual(JSON.parse(await request(first.port)).pid, first.info.pid, 'relaunch replaced active sessions');
    await stop(first.port);

    if (process.platform === 'win32') {
      const powershell = await exercise('powershell.exe', port => [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(moved, 'launch.ps1'),
        '-NoBrowser', '-Port', String(port),
      ]);
      await stop(powershell.port);
      const batch = await exercise(process.env.ComSpec || 'cmd.exe', port => [
        '/d', '/s', '/c', `""${path.join(moved, 'run.bat')}" --no-open --port ${port}"`,
      ], { windowsVerbatimArguments: true });
      await stop(batch.port);
    } else {
      const shell = await exercise('sh', port => [path.join(moved, 'run.sh'), '--no-open', '--port', String(port)]);
      await stop(shell.port);
    }

    const invalid = await run(process.execPath, [launcher, '--port', 'invalid']);
    assert.strictEqual(invalid.code, 1);
    assert.match(invalid.output, /--port requires an integer/);

    fs.writeFileSync(path.join(moved, 'server', 'index.js'), 'console.error("fixture startup error"); process.exit(7);');
    const failed = await run(process.execPath, nodeArgs(await freePort()));
    assert.strictEqual(failed.code, 1, failed.output);
    assert.match(failed.output, /Server exited during startup/);
    assert.match(fs.readFileSync(path.join(profile, '.xterm', 'logs', 'server-stderr.log'), 'utf8'), /fixture startup error/);
    const foreground = await run(process.execPath, [launcher, '--fg', '--no-open', '--port', String(await freePort())]);
    assert.strictEqual(foreground.code, 7, foreground.output);

    // A different program on the port must not be mistaken for xterm.
    fs.writeFileSync(path.join(moved, 'server', 'index.js'), `
      require('http').createServer((req, res) => res.end('{}'))
        .listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
    `);
    let foreignApp = 'other';
    foreign = http.createServer((req, res) => {
      if (req.url === '/bootstrap.js') return res.end('window.__XTERM_TOKEN="fixture";');
      res.end(JSON.stringify({ app: foreignApp, pid: process.pid }));
    });
    foreign.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
    await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
    const collision = await run(process.execPath, nodeArgs(foreign.address().port));
    assert.strictEqual(collision.code, 1, collision.output);
    assert.strictEqual(JSON.parse(await request(foreign.address().port)).app, 'other');
    assert.match(fs.readFileSync(path.join(profile, '.xterm', 'logs', 'server-stderr.log'), 'utf8'), /EADDRINUSE/);

    // HTTP health alone must not let a launcher report success.
    foreignApp = 'xterm';
    const websocketFailed = await run(process.execPath, nodeArgs(foreign.address().port));
    assert.strictEqual(websocketFailed.code, 1, websocketFailed.output);
    assert.match(websocketFailed.output, /Unexpected server response: 403/);
    assert.strictEqual(JSON.parse(await request(foreign.address().port)).pid, process.pid);

    // Exercise the actual server with a disposable profile, from an unrelated cwd.
    const actual = await exercise(process.execPath, port => [path.join(root, 'scripts', 'launch.js'), '--no-open', '--port', String(port)]);
    assert.match(await request(actual.port, '/'), /<title>(?:xterm|xterm)\b/);
    assert.match(await request(actual.port, '/bootstrap.js'), /__XTERM_TOKEN/);
    await stop(actual.port);
    console.log('✅ launcher relocation, wrappers, persistence, failure logs and real-server startup passed');
  } catch (error) {
    console.error('Launcher regression failed:', error);
    throw error;
  } finally {
    if (foreign) await new Promise(resolve => foreign.close(resolve));
    const logFile = path.join(profile, '.xterm', 'logs', 'launcher.log');
    if (fs.existsSync(logFile)) {
      for (const match of fs.readFileSync(logFile, 'utf8').matchAll(/Started detached server PID (\d+)/g)) {
        owned.add(Number(match[1]));
      }
    }
    for (const pid of owned) { try { process.kill(pid); } catch {} }
    await sleep(300);
    // Validate the generated absolute target before recursively cleaning it up.
    assert.strictEqual(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
    assert(path.basename(sandbox).startsWith('xterm-launch-'));
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
