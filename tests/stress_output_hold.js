// 客户端 output-hold 必须暂停 Telnet 读，放开后尾部标记仍要送到。
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8919;
const BASE = `http://127.0.0.1:${PORT}`;
const FLOOD_BYTES = 4 * 1024 * 1024;
const HOLD_BUDGET = 256 * 1024;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-hold-'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function sendInput(ws, id, text) {
  const payload = Buffer.from(text);
  const frame = Buffer.allocUnsafe(2 + payload.length);
  frame.writeUInt16LE(id, 0);
  payload.copy(frame, 2);
  ws.send(frame);
}

function countBinary(ws, id) {
  let bytes = 0;
  const handler = (raw, isBinary) => {
    if (!isBinary || raw.length < 2 || raw.readUInt16LE(0) !== id) return;
    bytes += raw.length - 2;
  };
  ws.on('message', handler);
  return {
    stop() { ws.off('message', handler); return bytes; },
  };
}

function collectUntil(ws, id, needle, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`missing ${needle}; got ${text.length} bytes, tail ${JSON.stringify(text.slice(-80))}`));
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
          try { sock.write('<<<HOLD-END>>>'); } catch {}
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
  let ws;
  try {
    const token = await getToken();
    const windowId = `holdstress${'h'.repeat(48)}`.slice(0, 64);
    ws = await openSocket(token, windowId);
    const pending = waitStatus(ws, 1, 'connected');
    ws.send(JSON.stringify({
      type: 'connect',
      id: 1,
      session: {
        name: 'hold-flood',
        type: 'telnet',
        host: '127.0.0.1',
        port: echoPort,
        reconnect: false,
      },
    }));
    await pending;

    ws.send(JSON.stringify({ type: 'output-hold' }));
    await sleep(50);
    const counter = countBinary(ws, 1);
    sendInput(ws, 1, 'FLOOD-NOW');
    await sleep(700);
    const held = counter.stop();
    assert(held < HOLD_BUDGET, `output-hold leaked ${held} bytes`);

    const end = collectUntil(ws, 1, '<<<HOLD-END>>>', 15000);
    ws.send(JSON.stringify({ type: 'output-release' }));
    const received = await end;
    assert(received.includes('<<<HOLD-END>>>'), 'tail must arrive after release');
    assert(received.length > FLOOD_BYTES / 2, 'release must deliver the flood, not only the marker');

    const ping = collectUntil(ws, 1, 'PING-OK', 5000);
    sendInput(ws, 1, 'PING-OK');
    await ping;

    assert.strictEqual(server.exitCode, null, `server exited: ${stderr.join('').slice(-500)}`);
    console.log(`✅ output-hold stress passed (held ${held} bytes of ${FLOOD_BYTES}, tail delivered after release)`);
  } finally {
    try { ws && ws.close(); } catch {}
    echo.close();
    if (server.exitCode == null && !server.killed) server.kill();
    await sleep(200);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
