'use strict';
// Real sandboxed Electron renderer + preload + IPC + disk + SFTP HTTP.
// Only the interactive folder dialog is replaced with deterministic answers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', path.join(process.env.XTERM_DOWNLOAD_TEST_ROOT, 'electron'));
  await app.whenReady();
  const destination = path.join(process.env.XTERM_DOWNLOAD_TEST_ROOT, 'downloads');
  const url = process.env.XTERM_DOWNLOAD_TEST_URL;
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { preload: path.join(ROOT, 'desktop', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  let choices = 0;
  require('../desktop/download-files').installDownloadFiles(win, { ipcMain, dialog: {
    async showOpenDialog() {
      choices++;
      await sleep(50);
      return choices === 1 ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [destination] };
    },
  } }, () => new URL(url).origin);
  try {
    await win.loadURL(url);
    const result = await win.webContents.executeJavaScript(`(${async function () {
      // Fixture connections are deliberately outside the real WS namespace.
      const originalHandleMsg = handleMsg;
      handleMsg = m => { if (m.type !== 'window-id') originalHandleMsg(m); };
      windowId = 'download-fixture';
      sftpConnId = '9900';
      sftpPath = '/';
      $('sftp-panel').classList.remove('hidden');
      // Native bridge must be used even if Chromium's picker is broken.
      window.showDirectoryPicker = () => { throw new Error('File picker already active'); };
      const cancelled = await pickSftpDownloadDir();
      const retry = pickSftpDownloadDir();
      const same = pickSftpDownloadDir();
      await Promise.all([retry, same]);
      const before = transferTasks.length;
      const first = downloadSftpItem({ name: 'sample.bin', isDir: false }, '/sample.bin');
      const duplicate = downloadSftpItem({ name: 'sample.bin', isDir: false }, '/sample.bin');
      await Promise.all([first, duplicate]);
      const single = transferTasks[0].state;
      const singleFailures = transferTasks[0].failedFiles;
      const tasksAdded = transferTasks.length - before;
      // Exercise nested directory handles and mixed selected items.
      sftpScanRemoteDir = async () => ({ files: [
        { name: 'nested/two.txt', path: '/folder/nested/two.txt', size: 6 },
        { name: 'one.txt', path: '/folder/one.txt', size: 3 },
      ] });
      await startSftpDownload([
        { name: 'folder', full: '/folder', isDir: true },
        { name: 'empty.txt', full: '/empty.txt', isDir: false },
      ], '下载选中');
      const batch = transferTasks[0].state;
      await downloadSftpItem({ name: 'missing.bin', isDir: false }, '/missing.bin');
      const failed = transferTasks[0].state;
      const failureVisible = !$('sftp-failures').classList.contains('hidden');
      // Atomic abort must retain a previous complete file.
      const file = await sftpDownloadDirHandle.getFileHandle('sample.bin', { create: true });
      const writer = await file.createWritable();
      await writer.write(new Uint8Array([99, 98]));
      await writer.abort();
      let traversalRejected = false;
      try { await sftpDownloadDirHandle.getFileHandle('../escape.txt', { create: true }); }
      catch { traversalRejected = true; }
      // Cancellation through the actual download UI must clean the temp file.
      const originalFetch = window.fetch;
      let fetched;
      const started = new Promise(resolve => { fetched = resolve; });
      window.fetch = async (_url, { signal }) => {
        fetched();
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array([7, 8]));
          signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')));
        } }), { headers: { 'Content-Length': '10' } });
      };
      const pending = downloadSftpItem({ name: 'cancelled.bin', isDir: false }, '/cancelled.bin');
      await started;
      await new Promise(resolve => setTimeout(resolve, 100));
      $('sftp-cancel-transfer').click();
      await pending;
      window.fetch = originalFetch;
      const cancelledState = transferTasks[0].state;
      return { cancelled, single, singleFailures, tasksAdded, batch, failed, failureVisible,
        traversalRejected, cancelledState, progressWidth: $('sftp-progress-bar').getBoundingClientRect().width };
    }.toString()})()`);
    assert.strictEqual(result.cancelled, null);
    assert.strictEqual(choices, 2, 'cancel/reopen and rapid clicks must use two native dialogs');
    assert.strictEqual(result.single, 'done', JSON.stringify(result.singleFailures));
    assert.strictEqual(result.tasksAdded, 1, 'one task for simultaneous download clicks');
    assert.strictEqual(result.batch, 'done');
    assert.strictEqual(result.failed, 'failed');
    assert.strictEqual(result.failureVisible, true);
    assert.strictEqual(result.traversalRejected, true);
    assert.strictEqual(result.cancelledState, 'cancelled');
    assert.deepStrictEqual(fs.readFileSync(path.join(destination, 'sample.bin')), Buffer.alloc(1024 * 1024, 42));
    assert.strictEqual(fs.readFileSync(path.join(destination, 'folder', 'nested', 'two.txt'), 'utf8'), 'nested');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'folder', 'one.txt'), 'utf8'), 'one');
    assert.strictEqual(fs.statSync(path.join(destination, 'empty.txt')).size, 0);
    assert(!fs.existsSync(path.join(destination, 'missing.bin')), 'failed downloads must not create a fake complete file');
    assert(!fs.existsSync(path.join(destination, 'cancelled.bin')), 'cancel must not commit partial data');
    assert(!fs.readdirSync(destination).some(name => name.endsWith('.part')), 'cancel/failure must remove temp files');
    const layout = await win.webContents.executeJavaScript(`
      $('terms').classList.add('sftp-open');
      $('sftp-panel').classList.remove('hidden');
      renderSftpList([{name:'sample.bin',size:1048576,isDir:false,mtime:Date.now()}]);
      showProgress('下载: sample.bin 37% · 378.9KB / 1.0MB', 37);
      $('sftp-cancel-transfer').classList.remove('hidden');
      newTransferTask('下载','sample.bin');
      updateTransferTask(transferTasks[0],37);
      ({width:$('sftp-progress-bar').getBoundingClientRect().width,
        overflow:$('sftp-progress').scrollWidth > $('sftp-progress').clientWidth});
    `);
    assert(layout.width > 150, 'download bar must remain visible in the file panel');
    assert.strictEqual(layout.overflow, false, 'progress text must fit the panel');
    // Reload releases old capability handles; a fresh picker still works.
    win.reload();
    await sleep(500);
    assert(await win.webContents.executeJavaScript('!!window.xtermDesktopFiles'));
    console.log('✓ Electron: native folder cancel/reopen, duplicate clicks, files/folders/empty files, real disk bytes, failures and atomic cancellation passed');
  } finally { win.destroy(); app.quit(); }
}

async function runParent() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-download-test-'));
  const remote = path.join(temp, 'remote');
  fs.mkdirSync(path.join(remote, 'folder', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'downloads'));
  fs.writeFileSync(path.join(remote, 'sample.bin'), Buffer.alloc(1024 * 1024, 42));
  fs.writeFileSync(path.join(remote, 'empty.txt'), '');
  fs.writeFileSync(path.join(remote, 'folder', 'one.txt'), 'one');
  fs.writeFileSync(path.join(remote, 'folder', 'nested', 'two.txt'), 'nested');
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const url = `http://127.0.0.1:${port}/`;
  const env = { ...process.env, USERPROFILE: path.join(temp, 'profile'), HOME: path.join(temp, 'profile'),
    XTERM_TEST_SFTP_ROOT: remote, XTERM_DOWNLOAD_TEST_ROOT: temp, XTERM_DOWNLOAD_TEST_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = spawn(process.execPath, ['server/index.js', '--no-open', '--port', String(port)], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  let child;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await new Promise(resolve => http.get(url, r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false)));
      if (!ready) await sleep(100);
    }
    assert(ready, 'test server must start');
    const code = await new Promise((resolve, reject) => {
      child = spawn(require('electron'), [__filename], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', data => process.stdout.write(data));
      child.stderr.on('data', data => process.stderr.write(data));
      const timer = setTimeout(() => { child.kill(); reject(new Error('Electron download test timed out')); }, 45000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.strictEqual(code, 0, 'Electron download checks failed');
  } finally {
    child?.kill();
    server.kill();
    await sleep(300);
    assert.strictEqual(path.dirname(temp), os.tmpdir());
    assert(path.basename(temp).startsWith('xterm-download-test-'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

(process.versions.electron ? runElectron() : runParent()).catch(error => {
  console.error(error.stack || error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
