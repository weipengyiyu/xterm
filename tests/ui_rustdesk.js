'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const puppeteer = require('./puppeteer_test');
const { createBackup } = require('../server/session-backup');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-rustdesk-ui-'));
const clientPath = path.join(profile, process.platform === 'win32' ? 'rustdesk.exe' : 'rustdesk');
const record = path.join(profile, 'launch.json');
fs.writeFileSync(clientPath, 'fixture', { mode: 0o755 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}/`;
  // Keep the real resolver, session store and WS route; replace only OS process creation.
  const runner = `
    const serviceModule = require('./server/rustdesk-service');
    const createController = serviceModule.createRustDeskServiceController;
    serviceModule.createRustDeskServiceController = () => {
      let state = { installed: false, running: false, state: 'NotInstalled', startup: '' };
      return createController({ platform: 'win32', launchRustDeskTray: async file => {
        require('fs').writeFileSync(process.env.XTERM_RD_RECORD + '.tray', file || 'default');
      }, runPowerShell: async script => {
        if (script === serviceModule.SERVICE_QUERY) return JSON.stringify(state);
        await new Promise(resolve => setTimeout(resolve, 250));
        if (require('fs').existsSync(process.env.XTERM_RD_RECORD + '.service-error')) throw new Error('管理员授权已取消');
        const encoded = script.match(/'-EncodedCommand', '([^']+)'/)[1];
        const operation = Buffer.from(encoded, 'base64').toString('utf16le');
        state = operation.includes('Start-Service')
          ? { installed: true, running: true, state: 'Running', startup: 'Automatic' }
          : { installed: true, running: false, state: 'Stopped', startup: 'Disabled' };
        return '';
      }});
    };
    const launcher = require('./server/rustdesk-launcher');
    const launch = launcher.launchRustDesk;
    launcher.launchRustDesk = config => launch(config, { spawn: (file, args, options) => {
      require('fs').writeFileSync(process.env.XTERM_RD_RECORD, JSON.stringify({ file, args, options }));
      const child = new (require('events').EventEmitter)(); child.unref = () => {};
      process.nextTick(() => child.emit('spawn')); return child;
    }});
    process.argv.push('--port', process.env.XTERM_RD_PORT, '--no-open');
    require('./server/index');
  `;
  const env = { ...process.env, USERPROFILE: profile, HOME: profile,
    XTERM_RUSTDESK: clientPath, XTERM_RD_RECORD: record, XTERM_RD_PORT: String(port) };
  let server, browser, electron;
  const startServer = async () => {
    server = spawn(process.execPath, ['-e', runner], { cwd: root, env, stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 100; i++) {
      const ready = await new Promise(resolve => {
        http.get(base, res => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
      });
      if (ready) return;
      await sleep(100);
    }
    throw new Error('RustDesk test server startup timed out');
  };
  const stopServer = async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill(); await exited;
    }
  };
  try {
    await startServer();
    if (process.env.XTERM_TEST_ELECTRON) {
      const debugPort = await new Promise(resolve => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
      });
      const desktopEnv = { ...env };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'XTERM_PROOF', 'XTERM_STARTUP_REQUEST']) delete desktopEnv[key];
      electron = spawn(require('electron'), ['desktop/main.js', '--port', String(port), `--remote-debugging-port=${debugPort}`],
        { cwd: root, env: desktopEnv, stdio: 'ignore', windowsHide: true });
      for (let i = 0; i < 100; i++) {
        try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` }); break; } catch { await sleep(100); }
      }
      assert(browser, 'Electron debugging endpoint must become ready');
    } else browser = await puppeteer.launch({
      executablePath: path.join(root, 'vendor', 'chrome-headless-shell', 'chrome-headless-shell.exe'),
      headless: 'new',
    });
    const page = electron ? await (async () => {
      for (let i = 0; i < 100; i++) {
        const page = (await browser.pages()).find(page => page.url().startsWith(base));
        if (page) return page;
        await sleep(100);
      }
      throw new Error('Electron application window did not load');
    })() : await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    if (!electron) await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.readyState === 'complete' && typeof ws !== 'undefined' && ws?.readyState === WebSocket.OPEN);
    await page.click('#btn-settings');
    await page.click('[data-settings-tab="rustdesk"]');
    await page.waitForFunction(() => !document.getElementById('set-rustdesk-service').disabled);
    assert.strictEqual(await page.$eval('#set-rustdesk-service', el => el.checked), false);
    assert(await page.$eval('#set-rustdesk-tray', el => el.disabled));
    await page.click('#set-rustdesk-service');
    assert(await page.$eval('#set-rustdesk-service', el => el.disabled), 'disable switch during service mutation');
    await page.waitForFunction(() => document.getElementById('set-rustdesk-service').checked && !document.getElementById('set-rustdesk-service').disabled);
    assert((await page.$eval('#set-rustdesk-status', el => el.textContent)).includes('运行中'));
    assert(fs.existsSync(record + '.tray'), 'enable automatically launches the tray');
    fs.unlinkSync(record + '.tray');
    await page.click('#set-rustdesk-tray');
    await page.waitForFunction(() => !document.getElementById('set-rustdesk-tray').disabled);
    assert(fs.existsSync(record + '.tray'), 'restore button launches tray without changing service state');
    await page.click('#set-rustdesk-refresh');
    await page.waitForFunction(() => !document.getElementById('set-rustdesk-service').disabled);
    assert(await page.$eval('#set-rustdesk-service', el => el.checked));
    await page.click('#set-rustdesk-service');
    await page.waitForFunction(() => !document.getElementById('set-rustdesk-service').checked && !document.getElementById('set-rustdesk-service').disabled);
    assert((await page.$eval('#set-rustdesk-status', el => el.textContent)).includes('已停止'));
    assert(await page.$eval('#set-rustdesk-tray', el => el.disabled));
    fs.writeFileSync(record + '.service-error', 'cancel');
    await page.click('#set-rustdesk-service');
    await page.waitForFunction(() => document.getElementById('set-rustdesk-status').textContent.includes('授权已取消'));
    assert.strictEqual(await page.$eval('#set-rustdesk-service', el => el.checked), false, 'failed operation restores actual state');
    assert.strictEqual(await page.$eval('#set-rustdesk-service', el => el.disabled), false, 'failure allows retry');
    fs.unlinkSync(record + '.service-error');
    await page.click('#set-rustdesk-refresh');
    await page.waitForFunction(() => document.getElementById('set-rustdesk-status').textContent.includes('已停止'));
    await page.screenshot({ path: path.join(profile, 'rustdesk-service.png') });
    if (process.env.XTERM_RD_SERVICE_SCREENSHOT) fs.copyFileSync(path.join(profile, 'rustdesk-service.png'), process.env.XTERM_RD_SERVICE_SCREENSHOT);
    await page.click('#settings-close');
    await page.click('#btn-new');
    await page.select('#f-type', 'rustdesk');
    await page.waitForFunction(clientPath => document.getElementById('r-client-status').textContent.includes(clientPath), {}, clientPath);
    assert(await page.$eval('#f-remember-wrap', el => el.classList.contains('hidden')));
    await page.click('#f-name');
    await page.keyboard.type('新建名称');
    await page.click('#f-group');
    await page.keyboard.type('新建分组');
    assert.strictEqual(await page.$eval('#f-name', el => el.value), '新建名称', 'name is editable immediately after opening');
    assert.strictEqual(await page.$eval('#f-group', el => el.value), '新建分组', 'group is editable immediately after opening');
    await page.$eval('#f-name', el => { el.value = ''; });
    await page.$eval('#f-group', el => { el.value = ''; });
    await page.type('#r-device-id', '123 456 789');
    await page.click('#btn-dlg-save');
    assert.strictEqual(dialogs.length, 0, 'connection validation must not open a blocking native alert');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'f-name', 'missing name returns focus to the editable name field');
    await page.keyboard.type('RustDesk 测试');
    await page.click('#f-group');
    await page.keyboard.type('远程桌面');
    assert.strictEqual(await page.$eval('#f-name', el => el.value), 'RustDesk 测试');
    assert.strictEqual(await page.$eval('#f-group', el => el.value), '远程桌面');
    await page.type('#r-client-path', clientPath);
    await page.click('#btn-dlg-save');
    await page.waitForFunction(() => sessions.some(s => s.type === 'rustdesk') && document.getElementById('sb-left').textContent.includes('已启动 RustDesk'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(record, 'utf8')).args, ['--connect', '123456789']);
    assert.strictEqual(await page.evaluate(() => tabs.length), 0, 'external sessions must not create terminal tabs');
    await page.type('#session-filter', '123456789');
    assert.strictEqual(await page.$$eval('.s-row', rows => rows.length), 1, 'filter by device ID');
    await page.hover('.s-row');
    await page.click('.s-row [data-act="edit"]');
    assert.strictEqual(await page.$eval('#r-client-path', el => el.value), clientPath);
    if (process.env.XTERM_RD_SCREENSHOT) await page.screenshot({ path: process.env.XTERM_RD_SCREENSHOT });
    await page.click('#btn-dlg-cancel');
    await stopServer();
    await startServer();
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => sessions.some(s => s.deviceId === '123456789'));
    fs.unlinkSync(record);
    await page.click('.s-row .type-badge', { count: 2 });
    await page.waitForFunction(() => document.getElementById('sb-left').textContent.includes('已启动 RustDesk'));
    assert(fs.existsSync(record), 'saved session launches after a backend restart');

    const passphrase = 'rustdesk-backup-test';
    const backup = createBackup([{ name: 'Imported RustDesk', type: 'rustdesk', deviceId: '987 654 321', clientPath }], passphrase);
    await page.evaluate(({ backup, passphrase }) => send({ type: 'import-sessions-backup', data: backup, passphrase }), { backup, passphrase });
    await page.waitForFunction(() => sessions.some(s => s.name === 'Imported RustDesk' && s.deviceId === '987654321'));
    assert.strictEqual(await page.evaluate(() => sessions.find(s => s.name === 'Imported RustDesk').clientPath), clientPath);

    await page.evaluate(() => newTab({ type: 'rustdesk', name: 'Missing client', deviceId: '123', clientPath: 'Z:\\missing\\rustdesk.exe' }));
    await page.waitForFunction(() => document.getElementById('sb-left').textContent.includes('启动失败'));
    assert.strictEqual(dialogs.length, 0, 'RustDesk launch failures must not block subsequent form input');
    assert.deepStrictEqual(errors, []);
    console.log('✅ RustDesk UI service switch/refresh and session save, detect, launch, edit, filter, restart, backup import and error feedback passed');
  } finally {
    if (browser) { if (electron) browser.disconnect(); else await browser.close(); }
    if (electron && electron.exitCode === null) {
      const exited = new Promise(resolve => electron.once('exit', resolve));
      electron.kill(); await exited;
    }
    await stopServer();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
