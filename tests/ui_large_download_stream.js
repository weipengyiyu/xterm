// Browser contract: large downloads write chunks directly to the selected
// file, retain Range retry, and never require a full-file Blob.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const EDGE = require('./browser_path')(ROOT);
const PORT = 8906;
const URL = `http://127.0.0.1:${PORT}/`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-large-download-'));
const profile = path.join(temp, 'profile');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForServer(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => http.get(URL, response => {
        response.resume();
        response.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`));
      }).on('error', reject));
      return;
    } catch { await sleep(100); }
  }
  throw new Error('server startup timed out');
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer();
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof streamDownloadToFile === 'function');

    const inputHost = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'input-regression';
      host.style.cssText = 'position:fixed;top:0;left:0;width:600px;height:180px;z-index:99999;background:black';
      document.body.appendChild(host);
      const term = new Terminal({ cols: 60, rows: 8 });
      term.open(host);
      bindClipboard({ term, host });
      window.regressionInput = '';
      term.onData(data => { window.regressionInput += data; });
      document.querySelector('#btn-new').focus();
      return host.id;
    });
    await page.click('#' + inputHost);
    await page.keyboard.type('a b');
    assert.strictEqual(await page.evaluate(() => window.regressionInput), 'a b', 'click must restore terminal focus and preserve space');
    await page.evaluate(() => document.getElementById('input-regression').remove());

    const nativeDownloads = await page.evaluate(async () => {
      window.showDirectoryPicker = undefined;
      const downloads = [];
      const original = startNativeDownload;
      startNativeDownload = (url, name) => downloads.push({ url, name });
      sftpConnId = 'regression-session';
      sftpPath = '/tmp';
      try {
        renderSftpList([{ name: 'a b.txt', isDir: false, size: 3, mtime: Date.now() }]);
        document.querySelector('#sftp-list .sftp-name').click();
        await downloadSftpItem({ name: 'folder', isDir: true }, '/tmp/folder');
        return downloads;
      } finally { startNativeDownload = original; }
    });
    assert.strictEqual(nativeDownloads.length, 2, 'file click and directory download must work without picker API');
    assert.strictEqual(nativeDownloads[0].name, 'a b.txt');
    assert(nativeDownloads[0].url.includes('/api/sftp/download?'));
    assert(nativeDownloads[1].url.includes('/api/sftp/download-dir?'));

    const pickerResult = await page.evaluate(async () => {
      sftpDownloadDirHandle = null;
      let pickerCalls = 0;
      let finishPicker;
      const outputs = [];
      const dir = { name: 'downloads', queryPermission: async () => 'granted',
        async getDirectoryHandle() { throw new Error('not found'); },
        async getFileHandle(name) {
          return { async createWritable() {
            return { async write(value) { outputs.push(...value); }, async close() {}, async abort() {} };
          } };
        } };
      window.showDirectoryPicker = () => {
        pickerCalls++;
        return new Promise(resolve => { finishPicker = resolve; });
      };
      const originalFetch = window.fetch;
      const calls = [];
      window.fetch = async url => {
        calls.push(url);
        let part = 0;
        return new Response(new ReadableStream({ async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (part++ < 2) controller.enqueue(new Uint8Array([1, 2]));
          else controller.close();
        } }), { headers: { 'Content-Length': '4' } });
      };
      try {
        sftpConnId = 'original-session';
        const pending = downloadSftpItem({ name: 'sample.txt', isDir: false }, '/source/sample.txt');
        await downloadSftpItem({ name: 'duplicate.txt', isDir: false }, '/source/duplicate.txt');
        const visibleWhilePicking = !$('sftp-progress').classList.contains('hidden');
        const sharedPicker = pickSftpDownloadDir();
        sftpConnId = 'changed-session';
        finishPicker(dir);
        await sharedPicker;
        await new Promise(resolve => setTimeout(resolve, 160));
        const during = { pct: transferTasks[0].pct, text: $('sftp-progress-text').textContent,
          width: $('sftp-progress-bar').getBoundingClientRect().width };
        await pending;
        // An old completion timer must not hide the next download's progress.
        showProgress('next download', 10);
        await new Promise(resolve => setTimeout(resolve, 2700));
        return { pickerCalls, calls, outputs, during, visibleWhilePicking,
          stillVisible: !$('sftp-progress').classList.contains('hidden'), state: transferTasks[0].state };
      } finally { window.fetch = originalFetch; sftpDownloadDirHandle = null; }
    });
    assert.strictEqual(pickerResult.pickerCalls, 1, 'rapid clicks must share one folder dialog');
    assert.strictEqual(pickerResult.calls.length, 1, 'rapid clicks must not duplicate the download');
    assert(pickerResult.calls[0].includes('conn=original-session'), 'source connection must be captured before choosing folder');
    assert.strictEqual(pickerResult.during.pct, 50, 'single file task must show real percentage');
    assert(pickerResult.during.text.includes('50%'), 'single file progress text must show percentage');
    assert.strictEqual(pickerResult.visibleWhilePicking, true, 'download preparation must be visible');
    assert.strictEqual(pickerResult.stillVisible, true, 'old completion timer must not hide a new transfer');
    assert.deepStrictEqual(pickerResult.outputs, [1, 2, 1, 2]);
    assert.strictEqual(pickerResult.state, 'done');

    const scanResult = await page.evaluate(async () => {
      const originalSend = send;
      const sent = [];
      send = m => sent.push(m);
      try {
        const controller = new AbortController();
        const cancelled = sftpScanRemoteDir('/folder', 'source', controller.signal).catch(e => e.name);
        const oldRequest = sent[0].requestId;
        controller.abort();
        const cancelledName = await cancelled;
        const next = sftpScanRemoteDir('/other', 'source');
        const currentRequest = sent[1].requestId;
        sftpConnId = 'changed-tab';
        handleMsg({ type: 'sftp', action: 'scan', id: 'source', requestId: oldRequest, files: [{ name: 'stale' }] });
        const staleIgnored = sftpPendingScan?.requestId === currentRequest;
        handleMsg({ type: 'sftp', action: 'scan', id: 'source', requestId: currentRequest, files: [{ name: 'correct' }] });
        const received = await next;
        const failed = sftpScanRemoteDir('/missing', 'source').catch(e => e.message);
        handleMsg({ type: 'error', action: 'sftp', id: 'source', requestId: sent[2].requestId, msg: 'permission denied' });
        return { cancelledName, staleIgnored, received: received.files[0].name, error: await failed, released: !sftpPendingScan };
      } finally { send = originalSend; }
    });
    assert.deepStrictEqual(scanResult, { cancelledName: 'AbortError', staleIgnored: true,
      received: 'correct', error: 'permission denied', released: true });

    const result = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      const calls = [];
      const output = [];
      let position = 0;
      let closed = false;
      let aborted = false;
      const writable = {
        async write(value) {
          for (const byte of value) output[position++] = byte;
        },
        async seek(nextPosition) { position = nextPosition; },
        async close() { closed = true; },
        async abort() { aborted = true; },
      };
      const handle = { async createWritable() { return writable; } };
      window.fetch = async (url, options = {}) => {
        calls.push(options.headers?.Range || null);
        if (calls.length === 1) {
          let sent = false;
          const body = new ReadableStream({
            pull(controller) {
              if (sent) return;
              sent = true;
              controller.enqueue(Uint8Array.from([0, 1, 2, 3]));
              setTimeout(() => controller.error(new Error('simulated interruption')), 0);
            },
          });
          return new Response(body, { status: 200, headers: { 'Content-Length': '10' } });
        }
        return new Response(Uint8Array.from([4, 5, 6, 7, 8, 9]), {
          status: 206,
          headers: { 'Content-Length': '6', 'Content-Range': 'bytes 4-9/10' },
        });
      };
      try {
        const download = await streamDownloadToFile('/mock-large-file', Promise.resolve(handle), () => {}, 1);
        return { download, calls, output, closed, aborted };
      } finally {
        window.fetch = originalFetch;
      }
    });

    assert.deepStrictEqual(result.calls, [null, 'bytes=4-'], 'retry must continue from the written offset');
    assert.deepStrictEqual(result.output, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'disk stream byte order');
    assert.deepStrictEqual(result.download, { saved: true, size: 10, remoteIdentity: '' }, 'direct-to-disk result');
    assert.strictEqual(result.closed, true, 'successful file must be committed');
    assert.strictEqual(result.aborted, false, 'successful file must not be aborted');
    await page.setViewport({ width: 1440, height: 900 });
    const layout = await page.evaluate(() => {
      $('sftp-panel').classList.remove('hidden');
      $('terms').classList.add('sftp-open');
      $('sftp-local-list').innerHTML = '';
      renderSftpList([{ name: 'sample.bin', isDir: false, size: 1048576, mtime: Date.now() }]);
      $('sftp-path').value = '/home/linux/wp';
      const task = newTransferTask('下载', 'sample.bin');
      updateTransferTask(task, 50);
      _progLast = 0;
      showProgress('下载: sample.bin 50% · 512.0KB / 1.0MB', 50);
      $('sftp-cancel-transfer').classList.remove('hidden');
      return { width: $('sftp-progress-bar').getBoundingClientRect().width,
        overflow: $('sftp-progress').scrollWidth > $('sftp-progress').clientWidth };
    });
    assert(layout.width > 150, 'download bar must remain visible in file panel');
    assert.strictEqual(layout.overflow, false, 'download text must fit the panel');
    const screenshot = path.join(ROOT, '.tools', 'download-progress.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await sleep(150);
    await page.screenshot({ path: screenshot });
    console.log('✅ large download direct-to-disk browser contract passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
