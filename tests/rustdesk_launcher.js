'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { resolveRustDesk, launchRustDesk, launchRustDeskTray, openRustDeskClient } = require('../server/rustdesk-launcher');
const { sanitizeSession } = require('../server/session-schema');
const { installRustDeskPicker } = require('../desktop/rustdesk-picker');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-rustdesk-'));
  try {
    const dir = path.join(root, '客户端 with spaces & symbols');
    fs.mkdirSync(dir);
    const clientPath = path.join(dir, process.platform === 'win32' ? 'rustdesk.exe' : 'rustdesk');
    fs.writeFileSync(clientPath, 'fixture', { mode: 0o755 });
    const config = { name: 'Remote PC', type: 'rustdesk', deviceId: '123 456 789', clientPath };
    const options = { root, env: { PATH: dir } };
    assert.strictEqual(await resolveRustDesk('', options), clientPath, 'detect client on PATH');
    assert.strictEqual(await resolveRustDesk(clientPath, options), clientPath);
    await assert.rejects(resolveRustDesk(path.join(dir, 'cmd.exe'), options), /完整路径/);
    await assert.rejects(resolveRustDesk(path.join(root, path.basename(clientPath)), options), /不存在/);
    await assert.rejects(resolveRustDesk('rustdesk.exe', options), /完整路径/);

    let invocation;
    const result = await launchRustDesk(config, { ...options, spawn: (file, args, spawnOptions) => {
      invocation = { file, args, spawnOptions };
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    } });
    assert.strictEqual(result.deviceId, '123456789');
    assert.strictEqual(invocation.file, clientPath);
    assert.deepStrictEqual(invocation.args, ['--connect', '123456789']);
    assert.strictEqual(invocation.spawnOptions.shell, false);
    assert.strictEqual(invocation.spawnOptions.detached, true);
    assert.strictEqual(invocation.spawnOptions.cwd, dir);
    await openRustDeskClient(clientPath, { ...options, spawn: (file, args, spawnOptions) => {
      assert.strictEqual(file, clientPath);
      assert.deepStrictEqual(args, [], 'opening the client does not require a remote ID or service command');
      assert.strictEqual(spawnOptions.windowsHide, false);
      assert.strictEqual(spawnOptions.shell, false);
      const child = new EventEmitter(); child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    } });
    await launchRustDeskTray(clientPath, { ...options, spawn: (file, args, spawnOptions) => {
      assert.strictEqual(file, clientPath);
      assert.deepStrictEqual(args, ['--tray']);
      assert.strictEqual(spawnOptions.shell, false);
      assert.strictEqual(spawnOptions.windowsHide, true);
      assert.strictEqual(spawnOptions.detached, true);
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    } });
    await assert.rejects(launchRustDeskTray(clientPath, { ...options, spawn: () => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit('error', new Error('ENOEXEC')));
      return child;
    } }), /托盘程序/);
    await assert.rejects(launchRustDesk({ ...config, deviceId: '--password' }), /有效/);
    await assert.rejects(launchRustDesk({ ...config, deviceId: '123 & calc.exe' }), /有效/);
    await assert.rejects(launchRustDesk(config, { spawn: () => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit('error', new Error('ENOEXEC')));
      return child;
    } }), /无法启动/);

    const clean = sanitizeSession({ ...config, password: 'secret', rememberPassword: true,
      host: 'old-host', port: 22, privateKey: 'key', autoCmds: ['command'] });
    assert.strictEqual(clean.deviceId, '123456789');
    assert.strictEqual(clean.clientPath, clientPath);
    assert.strictEqual(clean.rememberPassword, false);
    for (const field of ['host', 'port', 'password', 'privateKey', 'autoCmds']) assert(!(field in clean));
    assert.strictEqual(sanitizeSession({ ...config, deviceId: '-option' }), null);
    const win = new EventEmitter();
    win.webContents = { mainFrame: { url: 'http://127.0.0.1:8787/' } };
    let handler, removed = false, picked = 0;
    installRustDeskPicker(win, {
      ipcMain: { handle: (_name, callback) => { handler = callback; }, removeHandler: () => { removed = true; } },
      dialog: { showOpenDialog: async () => { picked++; return { canceled: false, filePaths: [clientPath] }; } },
    }, () => 'http://127.0.0.1:8787');
    await assert.rejects(handler({ sender: {}, senderFrame: win.webContents.mainFrame }), /不允许/);
    await assert.rejects(handler({ sender: win.webContents, senderFrame: { url: 'https://example.com' } }), /不允许/);
    assert.strictEqual(picked, 0, 'untrusted callers cannot open the picker');
    assert.strictEqual(await handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }), clientPath);
    win.emit('closed');
    assert(removed, 'picker handler is removed when its window closes');
    console.log('✅ RustDesk detection, safe launch arguments, errors and session schema passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
