'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverScript = path.join(root, 'server', 'index.js');
const stateDir = path.join(os.homedir(), '.xterm');
const logDir = path.join(stateDir, 'logs');
const launcherLog = path.join(logDir, 'launcher.log');
const stderrLog = path.join(logDir, 'server-stderr.log');
const stdoutLog = path.join(logDir, 'server-stdout.log');
const lockPath = path.join(stateDir, 'launcher.lock');
const READY_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(launcherLog, `${new Date().toISOString()} ${message}\n`);
}

function stderrTail() {
  try {
    const text = fs.readFileSync(stderrLog, 'utf8').trim();
    if (!text) return '';
    return text.split(/\r?\n/).slice(-6).join(' | ').slice(-400);
  } catch {
    return '';
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockHeldByLiveProcess() {
  let pid = NaN;
  try {
    pid = Number(String(fs.readFileSync(lockPath, 'utf8')).trim());
  } catch {
    return fs.existsSync(lockPath);
  }
  if (pidAlive(pid)) return true;
  // The creator can exist for a moment before the pid lands in the file.
  if (!Number.isInteger(pid) || pid <= 0) {
    try { return Date.now() - fs.statSync(lockPath).mtimeMs < 2000; } catch { return false; }
  }
  return false;
}

function releaseLock(owned) {
  if (!owned) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

// Only one cold start may spawn a server. Other clicks wait and reuse it.
// Returns false when a server is already listening, so the caller must not spawn.
async function acquireStartLock(url) {
  fs.mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await runningInfo(url)) return false;
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!lockHeldByLiveProcess()) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      await sleep(250);
    }
  }
  if (await runningInfo(url)) return false;
  throw new Error('Another startup is still in progress. Wait a moment and try again.');
}

function runningInfo(url) {
  return new Promise(resolve => {
    const request = http.get(`${url}launcher-info`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) request.destroy();
      });
      response.on('error', () => resolve(null));
      response.on('aborted', () => resolve(null));
      response.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(response.statusCode === 200 && info.app === 'xterm' && Number.isInteger(info.pid) ? info : null);
        } catch { resolve(null); }
      });
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function verifyBrowserConnection(url) {
  const token = await new Promise((resolve, reject) => {
    const req = http.get(`${url}bootstrap.js`, { headers: { Referer: url } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Browser token request was aborted.')));
      response.on('end', () => {
        try {
          const match = body.match(/window\.__XTERM_TOKEN=(.+?);/);
          if (response.statusCode !== 200 || !match) throw new Error('Browser token is unavailable.');
          resolve(JSON.parse(match[1]));
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Browser token request timed out.')));
    req.on('error', reject);
  });
  const { WebSocket } = require('ws');
  const windowId = require('crypto').randomBytes(32).toString('hex');
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}?token=${encodeURIComponent(token)}&window=${windowId}`, {
      headers: { Origin: new URL(url).origin }, handshakeTimeout: 5000,
    });
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.close();
      const cleanup = setTimeout(() => socket.terminate(), 250);
      cleanup.unref();
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('WebSocket session-list request timed out.')), 5000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'list' })));
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('WebSocket closed before receiving the session list.')));
    socket.on('message', (raw, binary) => {
      if (binary) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'sessions' && Array.isArray(message.list)) finish();
      } catch {}
    });
  });
}

function openDesktop(port) {
  let electronPath = '';
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string') electronPath = resolved;
  } catch {}
  if (!electronPath || !fs.existsSync(electronPath)) {
    throw new Error('Desktop window is not installed. Run npm install in the application folder.');
  }
  const child = spawn(electronPath, [path.join(root, 'desktop', 'main.js'), '--port', String(port)], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, XTERM_NODE: process.execPath },
  });
  child.unref();
  log(`Opened application window on port ${port}`);
}

function ensureInstalled() {
  if (!fs.existsSync(serverScript)) throw new Error(`Server script not found: ${serverScript}`);
  if (fs.existsSync(path.join(root, 'node_modules'))) return;
  console.log('[FIRST RUN] Installing dependencies...');
  // npm.cmd needs cmd.exe on Windows. These arguments are fixed; the project
  // directory is passed separately, never interpolated into a shell command.
  const install = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], {
    cwd: root, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32',
  });
  if (install.error || install.status !== 0) {
    throw new Error(`npm install failed: ${install.error ? install.error.message : install.status}`);
  }
}

async function waitUntilListening(url, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.startupError) throw child.startupError;
    if (child.exitCode !== null || child.signalCode !== null || child.exited) {
      if (await runningInfo(url)) return;
      const detail = stderrTail();
      throw new Error(`Server exited during startup; see ${stderrLog}${detail ? `: ${detail}` : ''}`);
    }
    if (await runningInfo(url)) return;
    await sleep(250);
  }
  if (await runningInfo(url)) return;
  const detail = stderrTail();
  throw new Error(`Server was not ready within ${READY_TIMEOUT_MS / 1000} seconds; see ${stderrLog}${detail ? `: ${detail}` : ''}`);
}

function parseArgs(argv) {
  let port = 8787;
  let foreground = false;
  let noBrowser = false;
  let autoExit = false;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i].toLowerCase()) {
      case '--fg': foreground = true; break;
      case '--no-open': noBrowser = true; break;
      case '--auto-exit': autoExit = true; break;
      case '--port': {
        const value = argv[++i];
        if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) {
          throw new Error('--port requires an integer from 1 to 65535.');
        }
        port = Number(value);
        break;
      }
      case '--help':
        console.log('Usage: node scripts/launch.js [--fg] [--no-open] [--port PORT] [--auto-exit]');
        return null;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return { port, foreground, noBrowser, autoExit };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const { port, foreground, noBrowser, autoExit } = options;
  const url = `http://127.0.0.1:${port}/`;

  if (!foreground && !noBrowser && !autoExit) {
    ensureInstalled();
    openDesktop(port);
    log('Desktop application started.');
    return;
  }

  const adopt = async () => {
    await verifyBrowserConnection(url);
    log('Server already running; preserving active sessions and opening browser.');
  };

  if (await runningInfo(url)) {
    await adopt();
    return;
  }

  ensureInstalled();
  if (await runningInfo(url)) {
    await adopt();
    return;
  }

  const serverArgs = [serverScript, '--port', String(port)];
  if (autoExit) serverArgs.push('--auto-exit');
  if (foreground) {
    if (noBrowser) serverArgs.push('--no-open');
    const child = spawn(process.execPath, serverArgs, { cwd: root, stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
    }
    child.on('exit', code => { process.exitCode = code === null ? 1 : code; });
    return;
  }

  const ownedLock = await acquireStartLock(url);
  if (!ownedLock) {
    await adopt();
    return;
  }
  try {
    if (await runningInfo(url)) {
      await adopt();
      return;
    }

    // Use file descriptors instead of pipes to the launcher. Output survives
    // launcher exit and retains diagnostics from the detached server.
    log(`Root: ${root}; Using Node: ${process.execPath}`);
    const stdout = fs.openSync(stdoutLog, 'a');
    let stderr;
    let child;
    try {
      stderr = fs.openSync(stderrLog, 'a');
      child = spawn(process.execPath, [...serverArgs, '--no-open'], {
        cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
      });
    } finally {
      fs.closeSync(stdout);
      if (stderr !== undefined) fs.closeSync(stderr);
    }
    child.exited = false;
    child.on('error', error => { child.startupError = error; });
    child.on('exit', () => { child.exited = true; });
    child.unref();
    log(`Started detached server PID ${child.pid}`);
    await waitUntilListening(url, child);
  } finally {
    releaseLock(ownedLock);
  }

  await verifyBrowserConnection(url);
  log('Server started successfully.');
  console.log(`xterm: ${url}`);
}

main().catch(error => {
  try { log(`Startup failed: ${error.message}`); } catch {}
  console.error(`Startup failed: ${error.message}\nLog: ${launcherLog}`);
  process.exitCode = 1;
});
