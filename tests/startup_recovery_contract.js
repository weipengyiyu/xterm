'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const guard = fs.readFileSync(path.join(__dirname, '..', 'web', 'startup-guard.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.main.js'), 'utf8');

function fixture(url = 'http://127.0.0.1:8787/') {
  const listeners = {};
  const timers = new Map();
  const status = { textContent: '未连接服务器' };
  let sequence = 0;
  const result = { replaced: [], history: [], status };
  class Script {}
  class ScriptError { constructor() { this.filename = 'http://127.0.0.1:8787/app.main.js'; } }
  const context = {
    URL, Date, HTMLScriptElement: Script, ErrorEvent: ScriptError,
    location: { href: url, replace: url => result.replaced.push(url) },
    history: { replaceState: (_, __, url) => result.history.push(String(url)) },
    document: { addEventListener: (name, fn) => { listeners[name] = fn; }, getElementById: () => status },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    setTimeout: (fn, delay) => { timers.set(++sequence, { fn, delay }); return sequence; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(guard, context);
  result.emit = name => listeners[name]();
  result.error = () => listeners.error(new ScriptError());
  result.tick = delay => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay) { timers.delete(id); timer.fn(); }
    }
  };
  return result;
}

const missing = fixture();
missing.tick(6000);
assert.strictEqual(missing.replaced.length, 1, 'missing main script must recover from initial status');
assert(new URL(missing.replaced[0]).searchParams.has('_startupRetry'));

const broken = fixture();
broken.error();
broken.tick(250);
assert.strictEqual(broken.replaced.length, 1, 'a script parse failure must trigger fresh loading');
const permanent = fixture(broken.replaced[0]);
permanent.error();
permanent.tick(250);
permanent.tick(6000);
assert.strictEqual(permanent.replaced.length, 0, 'permanent failures must not reload endlessly');
assert.match(permanent.status.textContent, /界面初始化失败/);

const recovered = fixture(broken.replaced[0]);
recovered.emit('xterm:connected');
recovered.emit('xterm:initialized');
recovered.tick(6000);
assert.strictEqual(recovered.replaced.length, 0);
assert.strictEqual(recovered.history[0], 'http://127.0.0.1:8787/', 'successful recovery must remove retry markers');

const benign = fixture();
benign.error();
benign.emit('xterm:initialized');
benign.emit('xterm:connected');
benign.tick(250);
benign.error();
benign.tick(250);
assert.strictEqual(benign.replaced.length, 0, 'a recovered or running UI must keep active connections');

// Exercise the real connect function against a handshake that never finishes.
const connectSource = app.slice(app.indexOf('function connectWebSocket()'), app.indexOf('// ---------- WS 连接 ----------'));
let timeout;
let reconnects = 0;
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor() { this.readyState = 0; }
  close() { this.closed = true; this.readyState = 3; }
}
const context = {
  ws: null, clientToken: 'test', WebSocket: Socket,
  $: () => ({ textContent: '' }), wsUrl: () => 'ws://127.0.0.1:8787/',
  scheduleWsReconnect: () => { reconnects++; }, onWsOpen() {}, onWsClose() {}, onWsMessage() {},
  setTimeout: (fn, delay) => { assert.strictEqual(delay, 5000); timeout = fn; return 1; },
};
vm.runInNewContext(`${connectSource}\nconnectWebSocket();`, context);
timeout();
assert(context.ws.closed, 'a stalled handshake must close instead of remaining CONNECTING forever');
assert.strictEqual(reconnects, 1);
console.log('✅ startup failure recovery, retry bounds and WebSocket handshake timeout passed');
