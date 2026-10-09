'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { check, reachable, installEnvironment } = require('../scripts/dependencies');

(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-deps-'));
  let listener;
  try {
    fs.mkdirSync(path.join(fixture, 'node_modules'));
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ dependencies: { ws: '*' } }));
    assert.match(check(fixture, false), /Missing dependency: ws/, 'an existing empty node_modules is not installed');
    fs.cpSync(path.dirname(require.resolve('ws/package.json')), path.join(fixture, 'node_modules', 'ws'), { recursive: true });
    assert.strictEqual(check(fixture, false), '');
    const electron = path.join(fixture, 'node_modules', 'electron');
    fs.mkdirSync(electron);
    fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', main: 'index.js' }));
    fs.writeFileSync(path.join(electron, 'index.js'), 'module.exports = __dirname + "/missing.exe";');
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ dependencies: { ws: '*', electron: '*' } }));
    assert.match(check(fixture, true), /Electron executable is missing/);
    assert.strictEqual(check(fixture, false), '', 'server startup does not require Electron');
    fs.writeFileSync(path.join(fixture, 'portable.json'), JSON.stringify({ platform: 'wrong', arch: process.arch, nodeAbi: process.versions.modules }));
    assert.match(check(fixture, false), /requires wrong/, 'wrong-platform native runtimes must be rejected');
    listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const proxy = `http://127.0.0.1:${listener.address().port}`;
    assert.strictEqual(await reachable(proxy), true);
    await new Promise(resolve => listener.close(resolve));
    listener = null;
    assert.strictEqual(await reachable(proxy), false);
    const oldProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = proxy;
    try {
      const install = await installEnvironment(fixture, () => {});
      assert(!install.env.HTTPS_PROXY);
      assert(install.args.includes('--https-proxy=null'));
      assert.strictEqual(process.env.HTTPS_PROXY, proxy, 'global/process proxy preferences remain unchanged');
    } finally {
      if (oldProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldProxy;
    }
    console.log('Dependency recovery: incomplete install, missing Electron, platform mismatch and dead proxy passed');
  } finally {
    if (listener) listener.close();
    assert.strictEqual(path.dirname(fixture), os.tmpdir());
    assert(path.basename(fixture).startsWith('xterm-deps-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
