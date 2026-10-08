// 本机 Shell 压力与稳定性: 多路 ConPTY 建连/断开 + 高速输出后命令仍可回显。
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8918;
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENTS = 6;
const ROUNDS = 4;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-local-stress-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-local-cwd-'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function workingSet(pid) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
    ], { encoding: 'utf8', timeout: 8000 });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function getToken(deadline = Date.now() + 12000) {
  while (Date.now() < deadline) {
    try {
      const response = await get(`${BASE}/bootstrap.js`, {
        Origin: BASE, Referer: `${BASE}/`,
      });
      const match = response.body.toString().match(/"([A-Za-z0-9_-]+)"/);
      if (match) return match[1];
    } catch {}
    await sleep(80);
  }
  throw new Error('server startup timed out');
}

function openSocket(token, windowId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/?token=${token}&window=${windowId}`, {
      headers: { Origin: BASE },
    });
    const fail = (err) => { cleanup(); reject(err); };
    const handler = (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString());
      if (message.type !== 'window-id') return;
      cleanup();
      resolve(ws);
    };
    const cleanup = () => ws.off('message', handler);
    ws.on('message', handler);
    ws.on('error', fail);
  });
}

function waitStatus(ws, id, state, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`status ${state} timed out for ${id}`));
    }, timeout);
    const handler = (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString());
      if (message.type === 'error' && message.id === id) {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new Error(message.msg || 'connect error'));
        return;
      }
      if (message.type === 'status' && message.id === id && message.state === state) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(message);
      }
    };
    ws.on('message', handler);
  });
}

function collectUntil(ws, id, needle, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`missing ${needle} in ${JSON.stringify(text.slice(-180))}`));
    }, timeout);
    const handler = (raw, isBinary) => {
      if (!isBinary || raw.length < 2 || raw.readUInt16LE(0) !== id) return;
      text += raw.subarray(2).toString('utf8');
      if (!text.includes(needle)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(text);
    };
    ws.on('message', handler);
  });
}

function sendInput(ws, id, text) {
  const payload = Buffer.from(text);
  const frame = Buffer.allocUnsafe(2 + payload.length);
  frame.writeUInt16LE(id, 0);
  payload.copy(frame, 2);
  ws.send(frame);
}

async function openLocal(token, windowId) {
  const ws = await openSocket(token, windowId);
  const pending = waitStatus(ws, 1, 'connected', 12000);
  ws.send(JSON.stringify({
    type: 'connect',
    id: 1,
    session: {
      name: 'local-stress',
      type: 'local',
      shell: 'cmd',
      cwd,
      reconnect: false,
    },
  }));
  await pending;
  return ws;
}

function closeLocal(ws) {
  return new Promise((resolve) => {
    try { ws.send(JSON.stringify({ type: 'disconnect', id: 1 })); } catch {}
    ws.once('close', resolve);
    try { ws.close(); } catch { resolve(); }
  });
}

(async () => {
  const stderr = [];
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => stderr.push(d.toString()));
  const sockets = [];
  try {
    const token = await getToken();
    const rssBefore = workingSet(server.pid);

    for (let round = 1; round <= ROUNDS; round++) {
      const opened = [];
      await Promise.all(Array.from({ length: CLIENTS }, async (_, i) => {
        const windowId = `local${round}x${i}${'w'.repeat(48)}`.slice(0, 64);
        const ws = await openLocal(token, windowId);
        opened.push(ws);
        const mark = `MARK-${round}-${i}`;
        const seen = collectUntil(ws, 1, mark, 8000);
        sendInput(ws, 1, `echo ${mark}\r\n`);
        await seen;
      }));
      await Promise.all(opened.map(closeLocal));
    }

    const floodId = `localflood${'f'.repeat(48)}`.slice(0, 64);
    const flood = await openLocal(token, floodId);
    sockets.push(flood);
    sendInput(flood, 1, `powershell -NoProfile -Command "1..2500 | ForEach-Object { 'A' * 100 }"\r\n`);
    await sleep(500);
    const end = collectUntil(flood, 1, 'ENDMARKER', 25000);
    sendInput(flood, 1, 'echo ENDMARKER\r\n');
    await end;
    await closeLocal(flood);

    const afterId = `localafter${'a'.repeat(48)}`.slice(0, 64);
    const after = await openLocal(token, afterId);
    sockets.push(after);
    const again = collectUntil(after, 1, 'PING-OK', 8000);
    sendInput(after, 1, 'echo PING-OK\r\n');
    await again;
    await closeLocal(after);

    assert.strictEqual(server.exitCode, null, `server exited: ${stderr.join('').slice(-500)}`);
    const rssAfter = workingSet(server.pid);
    const growthMb = rssBefore && rssAfter ? (rssAfter - rssBefore) / 1048576 : 0;
    if (rssAfter && growthMb > 300) {
      throw new Error(`RSS grew ${growthMb.toFixed(1)} MB across ${ROUNDS}×${CLIENTS} local shells`);
    }
    console.log(`✅ local shell stress passed (${ROUNDS}×${CLIENTS} cmd churn, flood, RSS Δ ${growthMb.toFixed(1)} MB)`);
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    if (server.exitCode == null && !server.killed) server.kill();
    await sleep(300);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
