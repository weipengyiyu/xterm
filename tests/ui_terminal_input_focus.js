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
      assert.strictEqual(actual.map(x => x.data).join(''), expected, JSON.stringify(await page.evaluate(() => ({
        active: document.activeElement?.outerHTML.slice(0, 300), focused: document.hasFocus(),
        blockers: [...document.querySelectorAll('[id$="-mask"]:not(.hidden), #search-bar:not(.hidden), #menu-more:not(.hidden), #menu-local:not(.hidden)')].map(el => el.id),
      }))));
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

    // Unknown focus loss: no click/close/window event is available to repair it.
    // The first Space must reach the terminal once, without activating a button.
    await page.evaluate(() => $('btn-more').focus());
    await page.keyboard.press('Space');
    await assertInput(' ', id);
    assert.strictEqual(await page.evaluate(() => broadcastInput), false, 'lost Space must not toggle broadcast');
    await page.evaluate(() => $('btn-more').focus());
    await page.waitForFunction(() => document.activeElement === inputTab.term.textarea, { timeout: 1500 });
    await assertInput('', id);
    // Native blur may leave activeElement unchanged but the widget inactive.
    await page.evaluate(() => inputTab.term.textarea.dispatchEvent(new FocusEvent('blur')));
    assert(await page.evaluate(() => !inputTab.term.element.classList.contains('focus')));
    await page.waitForFunction(() => inputTab.term.element.classList.contains('focus'), { timeout: 1500 });
    await page.keyboard.press('Space');
    await assertInput(' ', id);
    await page.evaluate(() => $('btn-more').focus());
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await assertInput('   ', id);
    for (const [key, expected] of [
      ['a', 'a'], ['A', 'A'], ['!', '!'], ['Space', ' '], ['Backspace', '\x7f'],
      ['Enter', '\r'], ['ArrowUp', '\x1b[A'],
    ]) {
      await page.evaluate(() => $('btn-more').focus());
      await page.keyboard.press(key);
      await assertInput(expected, id);
    }
    await page.evaluate(() => $('btn-more').focus());
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await assertInput('\x03', id);
    // Replay must honor the application's cursor-key mode, not guess ANSI bytes.
    await page.evaluate(() => new Promise(resolve => inputTab.term.write('\x1b[?1h', resolve)));
    await page.evaluate(() => $('btn-more').focus());
    await page.keyboard.press('ArrowUp');
    await assertInput('\x1bOA', id);
    await page.evaluate(() => new Promise(resolve => inputTab.term.write('\x1b[?1l', resolve)));

    // Native input continues on the recovered textarea; do not read the OS clipboard.
    await page.evaluate(() => {
      $('btn-more').focus();
      $('btn-more').dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true, bubbles: true, cancelable: true }));
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', 'paste a b');
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    });
    await assertInput('paste a b', id);
    await page.evaluate(() => {
      $('btn-more').focus();
      $('btn-more').dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
    });
    assert(await page.evaluate(() => document.activeElement === inputTab.term.textarea), 'IME start must recover terminal focus');
    const ime = await page.createCDPSession();
    await ime.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await assertInput('', id);
    await ime.send('Input.insertText', { text: '中文' });
    await page.waitForFunction(() => sentInput.length > 0);
    await assertInput('中文', id);
    await ime.detach();

    // Toolbar actions and dialogs used to leave focus on a button, rendering
    // an outline cursor and dropping subsequent terminal input.
    await page.click('#btn-more');
    await page.click('#btn-broadcast');
    await page.click('#btn-more');
    await page.click('#btn-broadcast');
    await page.keyboard.type(' toolbar ');
    await assertInput(' toolbar ', id);
    await page.click('#btn-more');
    await page.click('#btn-cmds');
    await page.click('#cmds-close');
    await page.keyboard.type(' commands ');
    await assertInput(' commands ', id);
    await page.click('#btn-new');
    await page.click('#btn-dlg-cancel');
    await page.keyboard.type(' cancel ');
    await assertInput(' cancel ', id);
    await page.click('#btn-new');
    await page.evaluate(() => $('btn-dlg-save').focus());
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement === $('btn-dlg-cancel')));
    await sleep(300);
    await page.keyboard.press('Space');
    await assertInput('', id);
    await page.keyboard.press('Space');
    await assertInput(' ', id);

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

    // Every tool dialog closes through the same visibility-based recovery.
    for (const [open, close] of [
      ['#mi-log', '#log-close'], ['#mi-timer', '#btn-tm-cancel'],
      ['#mi-scan', '#btn-scan-close'], ['#mi-transfer', '#transfer-close'],
    ]) {
      await page.click('#btn-more');
      await page.click(open);
      await page.click(close);
      await page.keyboard.press('Space');
      await assertInput(' ', id);
    }
    await page.click('#btn-more');
    await page.click('#btn-workspace');
    await page.click('#workspace-close');
    await page.keyboard.press('Space');
    await assertInput(' ', id);

    // The image prompt has no -mask suffix; Escape must also return input.
    await page.keyboard.down('Control');
    await page.keyboard.press('i');
    await page.keyboard.up('Control');
    await page.type('#xterm-display-prompt input', ' a b ');
    await assertInput('', id);
    await page.keyboard.press('Escape');
    await page.keyboard.type(' image ');
    await assertInput(' image ', id);

    // A visible sidebar field and keyboard-focused buttons retain their focus.
    await page.click('#session-filter');
    await page.keyboard.type(' a b ');
    await assertInput('', id);
    assert.strictEqual(await page.$eval('#session-filter', el => el.value), ' a b ');
    await page.evaluate(() => {
      const editor = document.createElement('div');
      editor.id = 'focus-test-editor';
      editor.contentEditable = 'true';
      editor.style.cssText = 'position:fixed;right:0;top:0;width:120px;height:30px;z-index:100';
      document.body.appendChild(editor);
      editor.focus();
    });
    await page.keyboard.type('a b ');
    await page.mouse.move(box.x + 35, box.y + 30);
    await sleep(300);
    assert.strictEqual(await page.$eval('#focus-test-editor', el => el.textContent.replace(/\u00a0/g, ' ')), 'a b ');
    assert(await page.evaluate(() => document.activeElement === $('focus-test-editor')), 'hover/idle detection must preserve editable widgets');
    await assertInput('', id);
    await page.evaluate(() => $('focus-test-editor').remove());
    await page.evaluate(() => { $('session-filter').value = ''; $('btn-new').focus(); });
    await page.keyboard.press('Tab');
    await sleep(300);
    assert(await page.evaluate(() => document.activeElement === $('btn-local')), 'Tab navigation must remain usable');
    await page.keyboard.press('Enter');
    assert(await page.evaluate(() => !$('menu-local').classList.contains('hidden')), 'keyboard-focused controls must still activate');
    await assertInput('', id);
    await page.click('#btn-local');

    await page.evaluate(() => $('btn-new').focus());
    await page.mouse.click(box.x + 30, box.y + 20, { button: 'right' });
    await page.keyboard.type(' r s ');
    await assertInput(' r s ', id);

    // Selection remains copyable, then spaces resume as normal input.
    await page.mouse.move(box.x + 12, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 10, { steps: 5 });
    await page.mouse.up();
    assert(await page.evaluate(() => inputTab.term.hasSelection()), 'mouse drag must preserve terminal selection: ' + JSON.stringify(await page.evaluate(() => ({
      selection: inputTab.term.getSelection(), box: document.querySelector('.term-host.main-pane').getBoundingClientRect().toJSON(),
      buffer: inputTab.term.buffer.active.getLine(0)?.translateToString(),
    }))));
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
    await page.evaluate(() => $('btn-more').focus());
    await page.keyboard.press('Space');
    await assertInput(' ', paneId);
    // Hovering over a pane repairs lost focus without requiring a click.
    await page.evaluate(() => {
      $('btn-more').focus();
      inputTab._focusTarget = inputTab;
    });
    await page.mouse.move(splitBox.x + 30, splitBox.y + splitBox.height - 55);
    assert(await page.evaluate(() => document.activeElement === inputTab.extraPanes[0].term.textarea), 'pointer movement must recognize the split needing focus');
    await page.keyboard.type(' hover ');
    await assertInput(' hover ', paneId);
    await page.evaluate(() => openSearch());
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await assertInput(' ', paneId);
    await page.click('#btn-more');
    await page.click('#btn-cmds');
    await page.type('#cmd-content', 'echo a b');
    await assertInput('', paneId);
    await page.click('#cmds-close');
    await page.keyboard.type(' pane ');
    await assertInput(' pane ', paneId);

    // Releasing a dragged divider returns input to the remembered split.
    const divider = await page.$eval('.split-divider:not(.col)', el => el.getBoundingClientRect().toJSON());
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    await page.mouse.move(divider.x + 30, divider.y + divider.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Space');
    await assertInput(' ', paneId);

    // A real browser page switch exercises blur/focus without a terminal click.
    await page.evaluate(() => $('btn-more').focus());
    const otherPage = await browser.newPage();
    await otherPage.bringToFront();
    await page.bringToFront();
    await page.waitForFunction(() => document.hasFocus() && document.activeElement === inputTab.extraPanes[0].term.textarea);
    await page.keyboard.type(' window ');
    await assertInput(' window ', paneId);
    // Focus on the terminal container/scrollbar is not input focus.
    await page.evaluate(() => {
      const container = inputTab.extraPanes[0].term.element;
      container.tabIndex = 0;
      container.focus();
    });
    await otherPage.bringToFront();
    await page.bringToFront();
    await page.waitForFunction(() => document.activeElement === inputTab.extraPanes[0].term.textarea);
    await page.keyboard.press('Space');
    await assertInput(' ', paneId);
    await page.click('#session-filter');
    await otherPage.bringToFront();
    await page.bringToFront();
    await page.keyboard.type(' field ');
    await assertInput('', paneId);
    assert.strictEqual(await page.$eval('#session-filter', el => el.value), ' field ');
    await otherPage.close();
    await page.evaluate(() => {
      $('dlg-mask').classList.remove('hidden');
      $('f-name').focus();
      focusActiveTerminal();
    });
    assert(await page.evaluate(() => document.activeElement === $('f-name')), 'dialog fields must keep their input focus');
    // Programmatic/asynchronous dialog close must work without an explicit focus call.
    await page.evaluate(() => $('dlg-mask').classList.add('hidden'));
    const focus = await page.evaluate(() => ({
      actual: document.activeElement === inputTab.extraPanes[0].term.textarea,
      cursor: inputTab.term.options.cursorStyle, splitCursor: inputTab.extraPanes[0].term.options.cursorStyle,
    }));
    assert.strictEqual(focus.actual, true);
    assert.strictEqual(focus.cursor, 'bar');
    assert.strictEqual(focus.splitCursor, 'bar');

    // Adding a pane must not later steal keys from the pane the user clicked.
    await page.evaluate(() => { addPane(inputTab); inputTab.extraPanes[1].state = 'connected'; });
    await page.evaluate(() => inputTab.extraPanes[0].term.focus());
    await sleep(150);
    await page.keyboard.press('Space');
    await assertInput(' ', paneId);
    await page.evaluate(() => removePane(inputTab, inputTab.extraPanes[1]));
    await page.click('.pane-split .pane-close');
    await page.keyboard.type(' main ');
    await assertInput(' main ', id);
    assert.deepStrictEqual(errors, []);
    console.log('✓ Terminal input: idle/hover recovery, first key/repeat/IME/paste, toolbar/dialogs, fields, selection, window return and splits passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
    await sleep(200);
    assert.strictEqual(path.dirname(temp), os.tmpdir());
    assert(path.basename(temp).startsWith('xterm-input-focus-'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
