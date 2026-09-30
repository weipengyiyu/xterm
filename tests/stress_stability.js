// 压力与稳定性: 多路 Telnet 建连/断开抖动 + 高速输出下最新数据必须送达。
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENTS = 12;
const ROUNDS = 6;
const FLOOD_BYTES = 4 * 1024 * 1024;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-stress-'));

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

function waitStatus(ws, id, state, timeout = 8000) {
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
      reject(new Error(`missing ${needle} in ${text.slice(-120)}`));
    }, timeout);
    const handler = (raw, isBinary) => {
      if (!isBinary || raw.length < 2 || raw.readUInt16LE(0) !== id) return;
      text += raw.subarray(2).toString('latin1');
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

function listenEcho() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        const text = chunk.toString('latin1');
        if (!text.includes('FLOOD-NOW')) {
          try { sock.write(chunk); } catch {}
          return;
        }
        const block = Buffer.alloc(16 * 1024, 0x41);
        let left = FLOOD_BYTES;
        const pump = () => {
          while (left > 0) {
            const n = Math.min(block.length, left);
            const ok = sock.write(n === block.length ? block : block.subarray(0, n));
            left -= n;
            if (!ok) {
              sock.once('drain', pump);
              return;
            }
          }
          sock.write('<<<STABILITY-END>>>');
        };
        pump();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const echo = await listenEcho();
  const echoPort = echo.address().port;
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
        const windowId = `stress${round}x${i}${'w'.repeat(40)}`.slice(0, 64);
        const ws = await openSocket(token, windowId);
        opened.push(ws);
        const pending = waitStatus(ws, 1, 'connected');
        ws.send(JSON.stringify({
          type: 'connect',
          id: 1,
          session: {
            name: `stress-${round}-${i}`,
            type: 'telnet',
            host: '127.0.0.1',
            port: echoPort,
            reconnect: false,
          },
        }));
        await pending;
        const mark = `MARK-${round}-${i}`;
        const seen = collectUntil(ws, 1, mark, 5000);
        sendInput(ws, 1, mark);
        await seen;
      }));
      await Promise.all(opened.map(ws => new Promise((resolve) => {
        ws.send(JSON.stringify({ type: 'disconnect', id: 1 }));
        ws.once('close', resolve);
        ws.close();
      })));
    }

    const windowId = `stressflood${'f'.repeat(48)}`.slice(0, 64);
    const ws = await openSocket(token, windowId);
    sockets.push(ws);
    const pending = waitStatus(ws, 1, 'connected');
    ws.send(JSON.stringify({
      type: 'connect',
      id: 1,
      session: {
        name: 'stress-flood',
        type: 'telnet',
        host: '127.0.0.1',
        port: echoPort,
        reconnect: false,
      },
    }));
    await pending;
    ws.pause();
    sendInput(ws, 1, 'FLOOD-NOW');
    await sleep(400);
    const end = collectUntil(ws, 1, '<<<STABILITY-END>>>', 15000);
    ws.resume();
    const received = await end;
    assert(received.includes('<<<STABILITY-END>>>'), 'tail marker must arrive after a flood');
    ws.send(JSON.stringify({ type: 'disconnect', id: 1 }));
    ws.close();

    const freshId = `stressafter${'a'.repeat(48)}`.slice(0, 64);
    const fresh = await openSocket(token, freshId);
    sockets.push(fresh);
    const freshStatus = waitStatus(fresh, 1, 'connected');
    fresh.send(JSON.stringify({
      type: 'connect',
      id: 1,
      session: {
        name: 'stress-after',
        type: 'telnet',
        host: '127.0.0.1',
        port: echoPort,
        reconnect: false,
      },
    }));
    await freshStatus;
    const again = collectUntil(fresh, 1, 'PING-OK', 5000);
    sendInput(fresh, 1, 'PING-OK');
    await again;

    assert.strictEqual(server.exitCode, null, `server exited: ${stderr.join('').slice(-500)}`);
    const rssAfter = workingSet(server.pid);
    const growthMb = rssBefore && rssAfter ? (rssAfter - rssBefore) / 1048576 : 0;
    if (rssAfter && growthMb > 250) {
      throw new Error(`RSS grew ${growthMb.toFixed(1)} MB across ${ROUNDS}×${CLIENTS} sessions`);
    }
    console.log(`✅ stability stress passed (${ROUNDS}×${CLIENTS} telnet churn, ${FLOOD_BYTES} byte flood, RSS Δ ${growthMb.toFixed(1)} MB)`);
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    echo.close();
    if (server.exitCode == null && !server.killed) server.kill();
    await sleep(200);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
