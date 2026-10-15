'use strict';
const assert = require('assert');
const { createRustDeskServiceController, SERVICE_QUERY } = require('../server/rustdesk-service');

(async () => {
  let state = { installed: false, running: false, state: 'NotInstalled', startup: '' };
  let changes = 0, resolved = 0, fail = false, noChange = false;
  const scripts = [];
  const trays = [];
  let trayFail = false;
  const controller = createRustDeskServiceController({ platform: 'win32',
    launchRustDeskTray: async clientPath => {
      trays.push(clientPath);
      if (trayFail) throw new Error('托盘启动失败');
    },
    resolveRustDesk: async () => { resolved++; return "C:\\RustDesk's $() ` folder\\rustdesk.exe"; },
    runPowerShell: async script => {
      if (script === SERVICE_QUERY) return JSON.stringify(state);
      scripts.push(script); changes++;
      if (fail) throw new Error('管理员授权已取消');
      const operation = Buffer.from(script.match(/'-EncodedCommand', '([^']+)'/)[1], 'base64').toString('utf16le');
      if (!noChange) state = operation.includes('Start-Service')
        ? { installed: true, running: true, state: 'Running', startup: 'Automatic', clientPath: 'C:\\Installed client\\rustdesk.exe' }
        : { installed: true, running: false, state: 'Stopped', startup: 'Disabled' };
      return '';
    },
  });
  assert.strictEqual((await controller.status()).installed, false);
  await controller.setEnabled(false);
  assert.strictEqual(changes, 0, 'absent service needs no elevation to disable');
  assert.strictEqual((await controller.setEnabled(true)).running, true);
  assert.deepStrictEqual(trays, ['C:\\Installed client\\rustdesk.exe'], 'tray uses installed service executable');
  await controller.showTray();
  assert.strictEqual(trays.length, 2, 'running service can restore tray independently');
  assert.strictEqual(resolved, 1);
  const operation = Buffer.from(scripts[0].match(/'-EncodedCommand', '([^']+)'/)[1], 'base64').toString('utf16le');
  assert(operation.includes("'C:\\RustDesk''s $() ` folder\\rustdesk.exe'"), 'path is literal data');
  assert(operation.includes('--silent-install'), 'install in a stable system directory');
  assert(scripts[0].includes('-Verb RunAs') && scripts[0].includes('-WindowStyle Hidden'));
  await controller.setEnabled(true);
  assert.strictEqual(changes, 1, 'enable is idempotent');
  assert.strictEqual(trays.length, 3, 'already running service still restores tray');
  trayFail = true;
  const trayFailure = await controller.setEnabled(true);
  assert.strictEqual(trayFailure.running, true);
  assert.strictEqual(trayFailure.trayError, '托盘启动失败', 'tray failure must preserve actual service state');
  await assert.rejects(controller.showTray(), /托盘启动失败/);
  trayFail = false;
  const trayCount = trays.length;
  assert.strictEqual((await controller.setEnabled(false)).startup, 'Disabled');
  assert.strictEqual(trays.length, trayCount, 'disable does not launch tray');
  await assert.rejects(controller.showTray(), /先开启/);
  assert.strictEqual(resolved, 1, 'existing service needs no client discovery');
  fail = true;
  await assert.rejects(controller.setEnabled(true), /授权/);
  assert.strictEqual((await controller.status()).busy, false);
  fail = false; noChange = true;
  await assert.rejects(controller.setEnabled(true), /预期状态/);
  await assert.rejects(controller.setEnabled('true'), /参数/);
  const unsupported = createRustDeskServiceController({ platform: 'linux', runPowerShell: () => assert.fail('must not run') });
  assert.strictEqual((await unsupported.status()).supported, false);
  await assert.rejects(unsupported.setEnabled(true), /Windows/);
  const missing = createRustDeskServiceController({ platform: 'win32', runPowerShell: async () => JSON.stringify({ installed: false, running: false, state: 'NotInstalled', startup: '' }), resolveRustDesk: async () => '' });
  await assert.rejects(missing.setEnabled(true), /未找到/);
  let finish;
  const locked = createRustDeskServiceController({ platform: 'win32', runPowerShell: () => new Promise(resolve => { finish = resolve; }) });
  const pending = locked.setEnabled(false);
  await assert.rejects(locked.setEnabled(true), /正在操作/);
  finish(JSON.stringify({ installed: false, running: false, state: 'NotInstalled', startup: '' }));
  await new Promise(resolve => setImmediate(resolve));
  finish(JSON.stringify({ installed: false, running: false, state: 'NotInstalled', startup: '' }));
  await pending;
  console.log('✅ RustDesk service start/stop, installation, elevation, literal paths, verification, errors and concurrency passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
