// Browser regression fixtures: serve the real UI with controlled startup faults.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');

async function fixture(mode) {
  let mainRequests = 0;
  let upgrades = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/fixture-info') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ mode, mainRequests, upgrades }));
    }
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    if (url.pathname === '/bootstrap.js') return res.end('window.__XTERM_TOKEN="fixture";');
    if (url.pathname === '/app.main.js') {
      mainRequests++;
      if (mode === 'always-fail' || (mode === 'fail-once' && mainRequests === 1)) {
        return res.end('const deliberately_broken = ;');
      }
    }
    const base = url.pathname.startsWith('/vendor/') ? path.join(root, 'node_modules') : path.join(root, 'web');
    const relative = url.pathname.startsWith('/vendor/') ? url.pathname.slice(8) : (url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' };
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); return res.end('not found'); }
      res.end(data);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    if (mode === 'stall-once' && upgrades === 1) return;
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', raw => {
        const message = JSON.parse(raw.toString());
        const responses = {
          list: { type: 'sessions', list: [] },
          serialports: { type: 'serialports', ports: [] },
          'local-shells': { type: 'local-shells', shells: [] },
        };
        if (responses[message.type]) ws.send(JSON.stringify(responses[message.type]));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { mode, url: `http://127.0.0.1:${server.address().port}/` };
}

(async () => {
  for (const mode of ['fail-once', 'always-fail', 'stall-once']) console.log(JSON.stringify(await fixture(mode)));
})().catch(error => { console.error(error); process.exitCode = 1; });
