'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-input-focus-'));
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn(process.execPath, ['server/index.js', '--no-open', '--port', String(port)], {
    cwd: ROOT, env: { ...process.env, USERPROFILE: temp, HOME: temp }, stdio: 'ignore', windowsHide: true,
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await new Promise(resolve => http.get(url, r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false)));
      if (!ready) await sleep(100);
    }
    assert(ready);
    browser = await puppeteer.launch({ executablePath: require('./browser_path')(ROOT), headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => {
      window.sentInput = [];
      sendInput = (id, data) => window.sentInput.push({ id, data });
      // Keep connection setup and directory listing out of this input test.
      send = () => {};
      navigator.clipboard.readText = async () => '';
      navigator.clipboard.writeText = async () => {};
      window.inputTab = newTab({ type: 'ssh', name: 'input', host: '127.0.0.1' }, { connect: false });
      setTabState(inputTab.id, 'connected');
      await new Promise(resolve => inputTab.term.write('linux@linux:~/wp$ ', resolve));
    });
    await sleep(100);
    async function assertInput(expected, id) {
      const actual = await page.evaluate(() => window.sentInput.splice(0));
      assert.strictEqual(actual.map(x => x.data).join(''), expected);
      assert(actual.every(x => x.id === id), 'keys must go to the clicked pane');
    }
    const id = await page.evaluate(() => {
      inputTab.term.options.cursorStyle = 'block';
      return inputTab.id;
    });
    const primary = '.term-host.main-pane';
    const box = await page.$eval(primary, el => el.getBoundingClientRect().toJSON());
    await page.mouse.click(box.x + 30, box.y + box.height - 50);
    await page.keyboard.type('ls  -l ');
    await assertInput('ls  -l ', id);
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await assertInput('  \x7f\r', id);
    await page.evaluate(() => applySettingsToAllTerminals());

    await page.click('#btn-sftp');
    await page.click('#sftp-close');
    await page.keyboard.type(' cd wp');
    await assertInput(' cd wp', id);

    await page.evaluate(() => openSearch());
    await page.type('#search-input', 'find me');
    await page.keyboard.press('Escape');
    await page.keyboard.type(' x y ');
    await assertInput(' x y ', id);

    await page.click('#btn-settings');
    await page.click('#settings-close');
    await page.keyboard.type(' a b ');
    await assertInput(' a b ', id);

    await page.evaluate(() => $('btn-new').focus());
    await page.mouse.click(box.x + 30, box.y + 20, { button: 'right' });
    await page.keyboard.type(' r s ');
    await assertInput(' r s ', id);

    // Selection remains copyable, then spaces resume as normal input.
    await page.mouse.move(box.x + 12, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 10, { steps: 5 });
    await page.mouse.up();
    assert(await page.evaluate(() => inputTab.term.hasSelection()), 'mouse drag must preserve terminal selection');
    await page.keyboard.type('  ');
    await assertInput('  ', id);

    const paneId = await page.evaluate(() => {
      addPane(inputTab);
      inputTab.extraPanes[0].state = 'connected';
      return inputTab.extraPanes[0].connId;
    });
    await sleep(160);
    const splitBox = await page.$eval('.pane-split', el => el.getBoundingClientRect().toJSON());
    await page.mouse.click(splitBox.x + 30, splitBox.y + splitBox.height - 50);
    await page.keyboard.type(' split  spaces ');
    await assertInput(' split  spaces ', paneId);
    await page.evaluate(() => openSearch());
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await assertInput(' ', paneId);
    await page.evaluate(() => {
      $('dlg-mask').classList.remove('hidden');
      $('f-name').focus();
      focusActiveTerminal();
    });
    assert(await page.evaluate(() => document.activeElement === $('f-name')), 'dialog fields must keep their input focus');
    await page.evaluate(() => { $('dlg-mask').classList.add('hidden'); focusActiveTerminal(); });
    const focus = await page.evaluate(() => ({
      actual: document.activeElement === inputTab.extraPanes[0].term.textarea,
      cursor: inputTab.term.options.cursorStyle, splitCursor: inputTab.extraPanes[0].term.options.cursorStyle,
    }));
    assert.strictEqual(focus.actual, true);
    assert.strictEqual(focus.cursor, 'bar');
    assert.strictEqual(focus.splitCursor, 'bar');
    assert.deepStrictEqual(errors, []);
    console.log('✓ Terminal input: spaces, panel/search/settings close, right click, selection and split focus passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
    await sleep(200);
    assert.strictEqual(path.dirname(temp), os.tmpdir());
    assert(path.basename(temp).startsWith('xterm-input-focus-'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
