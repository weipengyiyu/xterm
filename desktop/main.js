'use strict';

const { app, BrowserWindow, dialog, Menu, ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const protocol = require('./startup-protocol');
const { installDownloadFiles } = require('./download-files');

const root = path.resolve(__dirname, '..');
const serverScript = path.join(root, 'server', 'index.js');
const logDir = path.join(os.homedir(), '.xterm', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const stderrLog = path.join(logDir, 'server-stderr.log');
const requests = new Map();
const applicationPort = parsePort(process.argv);
let startupResult = null;
function desktopLog(message) {
  try { fs.appendFileSync(path.join(logDir, 'desktop.log'), `${new Date().toISOString()} [${process.pid}] ${message}\n`); } catch {}
}
function addRequest(value) {
  const request = protocol.validRequest(value);
  if (request) {
    requests.set(request.id, request);
    desktopLog(`Received launch ${request.id}`);
  }
}
function reportStartup(result) {
  startupResult = { port: applicationPort, ...result, pid: process.pid };
  for (const request of requests.values()) {
    try {
      protocol.writeResponse(request, startupResult);
      desktopLog(`Replied to launch ${request.id}: ${result.ok ? 'connected' : result.error}`);
    } catch (error) { desktopLog(`Reply failed for launch ${request.id}: ${error.message}`); }
  }
  requests.clear();
}
const initialRequest = protocol.readRequest();
addRequest(initialRequest);

let mainWindow = null;
let serverChild = null;
let serverOwned = false;
let revealOnReady = false;
let engineOrigin = '';

app.setName('xterm');
app.setPath('userData', path.join(os.homedir(), '.xterm', 'desktop'));
Menu.setApplicationMenu(null);

const gotLock = app.requestSingleInstanceLock({ xtermStartupRequest: initialRequest });
desktopLog(`Single instance lock: ${gotLock}`);
if (!gotLock) app.quit();

app.on('second-instance', (_event, _argv, _cwd, data) => {
  // Chromium may reorder/insert command-line switches. The structured payload
  // is the supported way to preserve the caller's exact request.
  addRequest(data && data.xtermStartupRequest);
  if (startupResult) {
    waitUntilConnected(mainWindow).then(status => {
      if (status) reportStartup({ ...startupResult, ok: true, status });
      else reportStartup({ ok: false, error: 'Existing application window is not connected to the engine.' });
    }).catch(error => reportStartup({ ok: false, error: error.message }));
  }
  revealOnReady = true;
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  const value = index >= 0 ? argv[index + 1] : '8787';
  if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) return 8787;
  return Number(value);
}

function findNode() {
  const bundled = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(bundled)) return bundled;
  if (process.env.XTERM_NODE && fs.existsSync(process.env.XTERM_NODE)) return process.env.XTERM_NODE;
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true });
    if (where.status === 0) {
      const found = String(where.stdout || '').split(/\r?\n/).map(line => line.trim()).find(line => line && fs.existsSync(line));
      if (found) return found;
    }
  }
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'hermes', 'node', 'node.exe'),
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}

function runningInfo(url) {
  return new Promise(resolve => {
    const request = http.get(`${url}launcher-info`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
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

async function ensureServer(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (await runningInfo(url)) return url;
  const nodeExe = findNode();
  if (!nodeExe) throw new Error('找不到 Node.js，无法启动终端引擎。');
  const stdout = fs.openSync(path.join(logDir, 'server-stdout.log'), 'a');
  const stderr = fs.openSync(stderrLog, 'a');
  let spawnError;
  try {
    serverChild = spawn(nodeExe, [serverScript, '--port', String(port), '--no-open'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', stdout, stderr],
    });
    serverChild.on('error', error => { spawnError = error; });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  serverOwned = true;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (serverChild.exitCode !== null) {
      if (await runningInfo(url)) {
        serverOwned = false;
        serverChild = null;
        return url;
      }
      let detail = '';
      try { detail = fs.readFileSync(stderrLog, 'utf8').trim().split(/\r?\n/).slice(-8).join('\n'); } catch {}
      throw new Error(`终端引擎在启动过程中退出了。\n${detail}\n日志：${stderrLog}`);
    }
    if (await runningInfo(url)) return url;
    await sleep(200);
  }
  throw new Error('终端引擎在 30 秒内没有就绪。');
}

function stopOwnedServer() {
  if (!serverOwned || !serverChild || serverChild.exitCode !== null) return;
  serverOwned = false;
  try { serverChild.kill(); } catch {}
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'xterm',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  installDownloadFiles(win, { ipcMain, dialog }, () => engineOrigin);
  win.setMenuBarVisibility(false);
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle('xterm');
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    let next;
    try { next = new URL(target); } catch { event.preventDefault(); return; }
    const current = mainWindow && mainWindow.webContents.getURL();
    if (!current || current.startsWith('file:')) return;
    if (next.origin !== new URL(current).origin) event.preventDefault();
  });
  win.on('closed', () => { mainWindow = null; });
  return win;
}

async function waitUntilConnected(win) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!win || win.isDestroyed()) return '';
    let status = '';
    try {
      status = await withTimeout(win.webContents.executeJavaScript(
        `document.getElementById('conn-status-text') ? document.getElementById('conn-status-text').textContent : ''`,
        true,
      ), 1000, 'Renderer did not answer the readiness check');
    } catch {}
    const text = String(status);
    if (text.includes('已连接') || text.includes('Server connected')) return text;
    await sleep(200);
  }
  return '';
}

function withTimeout(promise, timeout, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })])
    .finally(() => clearTimeout(timer));
}

async function start() {
  const port = applicationPort;
  mainWindow = createWindow();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await withTimeout(mainWindow.loadFile(path.join(__dirname, 'splash.html')), 15000, 'Startup screen failed to load');
  let url;
  try {
    url = await ensureServer(port);
    engineOrigin = new URL(url).origin;
  } catch (error) {
    reportStartup({ ok: false, error: error.message });
    if (process.env.XTERM_PROOF) {
      try { fs.writeFileSync(process.env.XTERM_PROOF, error.message || 'startup-failed'); } catch {}
    } else if (!initialRequest) {
      dialog.showErrorBox('xterm', error.message);
    }
    stopOwnedServer();
    app.quit();
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  await withTimeout(mainWindow.loadURL(`${url}?_launch=${Date.now()}`), 20000, 'Application page failed to load');
  const status = await waitUntilConnected(mainWindow);
  if (!status) throw new Error(`应用窗口未能连接终端引擎。日志：${stderrLog}`);
  if (!mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  reportStartup({ ok: true, port, status });
  desktopLog(`Window connected on port ${port}`);
  if (process.env.XTERM_PROOF) {
    try { fs.writeFileSync(process.env.XTERM_PROOF, status || 'not-connected'); } catch {}
    setTimeout(() => app.quit(), 400);
  }
}

app.on('window-all-closed', () => {
  stopOwnedServer();
  app.quit();
});
app.on('before-quit', stopOwnedServer);

if (gotLock) {
  app.whenReady().then(start).catch(error => {
    reportStartup({ ok: false, error: error.message || String(error) });
    if (process.env.XTERM_PROOF) {
      try { fs.writeFileSync(process.env.XTERM_PROOF, error.message || String(error)); } catch {}
    } else if (!initialRequest) {
      dialog.showErrorBox('xterm', error.message || String(error));
    }
    stopOwnedServer();
    app.quit();
  });
}
