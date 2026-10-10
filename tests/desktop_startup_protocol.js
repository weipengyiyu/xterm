'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const protocol = require('../desktop/startup-protocol');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-startup-contract-'));
try {
  const request = protocol.createRequest(directory);
  const environment = { XTERM_STARTUP_REQUEST: JSON.stringify(request) };
  assert.deepStrictEqual(protocol.readRequest(environment), request);
  assert.strictEqual(protocol.validRequest({ ...request, path: '--allow-file-access-from-files' }), null);
  assert.strictEqual(protocol.validRequest({ ...request, path: path.join(directory, 'unrelated.txt') }), null);
  assert.strictEqual(protocol.readRequest({ XTERM_STARTUP_REQUEST: '{broken' }), null);
  assert.strictEqual(protocol.readResponse(request), null);
  protocol.writeResponse(request, { ok: true, pid: 123, port: 8787, status: 'Server connected' });
  assert.strictEqual(protocol.readResponse(request).requestId, request.id);
  assert.throws(() => protocol.readResponse({ ...request, id: 'f'.repeat(32) }), /match this launch/);
  assert.throws(() => protocol.writeResponse({ ...request, path: '--allow-file-access-from-files' }, { ok: true }), /destination/);
  assert(!fs.existsSync(path.join(directory, '--allow-file-access-from-files')));
  console.log('Desktop protocol: structured request, response identity and invalid destinations passed');
} finally {
  fs.unlinkSync(path.join(directory, 'ready.json'));
  fs.rmdirSync(directory);
}
