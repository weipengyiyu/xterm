'use strict';

const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverScript = path.join(root, 'server', 'index.js');

let mainWindow = null;
let serverChild = null;
let serverOwned = false;
let revealOnReady = false;

app.setName('xterm');
app.setPath('userData', path.join(app.getPath('home'), '.sshterm', 'desktop'));
Menu.setApplicationMenu(null);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', () => {
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
  if (process.env.SSHTERM_NODE && fs.existsSync(process.env.SSHTERM_NODE)) return process.env.SSHTERM_NODE;
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
          resolve(response.statusCode === 200 && info.app === 'sshterm' && Number.isInteger(info.pid) ? info : null);
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
  serverChild = spawn(nodeExe, [serverScript, '--port', String(port), '--no-open'], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
  });
  serverOwned = true;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (serverChild.exitCode !== null) {
      if (await runningInfo(url)) {
        serverOwned = false;
        serverChild = null;
        return url;
      }
      throw new Error('终端引擎在启动过程中退出了。');
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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
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
    let status = '';
    try {
      status = await win.webContents.executeJavaScript(
        `document.getElementById('conn-status-text') ? document.getElementById('conn-status-text').textContent : ''`,
        true,
      );
    } catch {}
    const text = String(status);
    if (text.includes('已连接') || text.includes('Server connected')) return text;
    await sleep(200);
  }
  return '';
}

async function start() {
  const port = parsePort(process.argv);
  mainWindow = createWindow();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  let url;
  try {
    url = await ensureServer(port);
  } catch (error) {
    if (process.env.SSHTERM_PROOF) {
      try { fs.writeFileSync(process.env.SSHTERM_PROOF, error.message || 'startup-failed'); } catch {}
    } else {
      dialog.showErrorBox('xterm', error.message);
    }
    stopOwnedServer();
    app.quit();
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  await mainWindow.loadURL(`${url}?_launch=${Date.now()}`);
  const status = await waitUntilConnected(mainWindow);
  if (!mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  if (process.env.SSHTERM_PROOF) {
    try { fs.writeFileSync(process.env.SSHTERM_PROOF, status || 'not-connected'); } catch {}
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
    dialog.showErrorBox('xterm', error.message || String(error));
    stopOwnedServer();
    app.quit();
  });
}
