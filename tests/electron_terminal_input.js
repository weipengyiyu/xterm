'use strict';
// Real sandboxed Electron + preload IPC + WebSocket + local PTY. The window
// stays hidden; CDP focus emulation isolates the test from the user's desktop.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function runElectron() {
  console.log('Electron fixture: initializing');
  const { app, BrowserWindow, Menu } = require('electron');
  app.setPath('userData', path.join(process.env.XTERM_FOCUS_TEST_ROOT, 'electron'));
  app.commandLine.appendSwitch('disable-gpu');
  Menu.setApplicationMenu(null);
  await app.whenReady();
  console.log('Electron fixture: ready');
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { preload: path.join(ROOT, 'desktop', 'preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  require('../desktop/terminal-focus').installTerminalWindowFocus(win);
  const contents = win.webContents;
  const js = source => contents.executeJavaScript(source);
  const cdp = (method, params) => contents.debugger.sendCommand(method, params);
  contents.debugger.attach('1.3');
  try {
    await win.loadURL(process.env.XTERM_FOCUS_TEST_URL);
    console.log('Electron fixture: page loaded');
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await until(() => js("ws && ws.readyState === WebSocket.OPEN"), 'Electron did not connect to the engine');
    await js(`window.inputWire = [];
      const realSendInput = sendInput;
      sendInput = (...args) => { inputWire.push(args[1]); return realSendInput(...args); };
      window.nativeInputTab = newTab({ type: 'local', name: 'Electron input verification',
        shell: ${JSON.stringify(process.platform === 'win32' ? 'cmd' : 'bash')} }); void 0;`);
    await until(() => js("nativeInputTab.state === 'connected'"), 'Local PTY did not connect');
    await until(() => js('nativeInputTab.term.buffer.active.cursorX > 0'), 'Shell prompt did not arrive');
    console.log('Electron fixture: PTY connected');
    const press = async (key, code, vk, text = '', modifiers = 0) => {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code,
        windowsVirtualKeyCode: vk, text, unmodifiedText: text, modifiers });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    };
    await js("$('btn-more').focus()");
    contents.send('xterm-terminal-focus');
    await until(() => js('document.activeElement === nativeInputTab.term.textarea'), 'Native IPC did not return input to the terminal');
    await js("$('btn-more').focus(); inputWire.length = 0;");
    await press(' ', 'Space', 32, ' ');
    assert.strictEqual(await js("inputWire.join('').replace(/\\x1b\\[[IO]/g, '')"), ' ',
      'first Space must cross the real Electron input pipeline exactly once (excluding negotiated focus reports)');
    assert(await js("$('menu-more').classList.contains('hidden')"), 'Space must not activate the toolbar');
    const command = process.platform === 'win32' ? 'echo XTERM_FOCUS  SPACE_OK' : "printf 'XTERM_FOCUS  SPACE_OK\\n'";
    await cdp('Input.insertText', { text: command });
    await press('Enter', 'Enter', 13, '\r');
    await until(() => js(`Array.from({length:nativeInputTab.term.buffer.active.length}, (_, i) =>
      nativeInputTab.term.buffer.active.getLine(i)?.translateToString(true).trim()).includes('XTERM_FOCUS  SPACE_OK')`),
    'The real shell did not echo the command with both spaces intact');
    // Every DECSCUSR style must leave the selected thin-caret policy intact.
    await js('nativeInputTab.term.options.cursorBlink = false; nativeInputTab.term.focus();');
    for (let style = 0; style <= 6; style++) {
      await js(`new Promise(resolve => nativeInputTab.term.write(${JSON.stringify(`\x1b[${style} q`)}, resolve))`);
      assert.strictEqual(await js('nativeInputTab.term.options.cursorStyle'), 'bar');
      await assertCaretPixels(`Remote cursor style ${style}`);
    }
    async function assertCaretPixels(label) {
      await sleep(100);
      const geometry = await js(`(() => {
        const t = nativeInputTab.term, r = t.element.querySelector('.xterm-screen').getBoundingClientRect();
        const b = t.buffer.active;
        return { x:r.left+b.cursorX*r.width/t.cols, y:r.top+(b.cursorY+b.baseY-b.viewportY)*r.height/t.rows,
          width:r.width/t.cols, height:r.height/t.rows, viewportWidth:innerWidth };
      })()`);
      const image = await contents.capturePage();
      const size = image.getSize();
      const pixels = image.toBitmap({ scaleFactor: 1 });
      assert.strictEqual(pixels.length, size.width * size.height * 4);
      const scale = size.width / geometry.viewportWidth;
      const left = Math.round(geometry.x * scale);
      const y = Math.floor((geometry.y + geometry.height / 2) * scale);
      const bright = [];
      for (let x = 0; x < Math.floor(geometry.width * scale); x++) {
        const at = (y * size.width + left + x) * 4;
        if (Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) > 120) bright.push(x);
      }
      assert(bright.length > 0 && bright.at(-1) - bright[0] <= Math.ceil(2 * scale),
        `${label} cursor is not a thin line: ${JSON.stringify({ geometry, size, bright })}`);
    }
    await assertCaretPixels('Focused');
    await js("openSearch(); $('search-input').value = '';");
    contents.send('xterm-terminal-focus');
    await sleep(300);
    assert(await js("document.activeElement === $('search-input')"), 'native window notifications must preserve form input');
    assert.strictEqual(await js('nativeInputTab.term.options.cursorInactiveStyle'), 'bar');
    await assertCaretPixels('Inactive');
    await js('closeSearch(); window.oldDocumentMarker = true;');
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native reload shortcut did not reload')), 12000);
      contents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    });
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control', 'shift'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control', 'shift'] });
    await loaded;
    assert.strictEqual(await js('typeof window.oldDocumentMarker'), 'undefined');
    console.log('✓ Electron input: real PTY spaces, preload focus IPC, active/inactive caret pixels, remote cursor policy and native reload passed');
  } finally {
    win.destroy();
    app.quit();
  }
}

async function runNode() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-electron-input-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}/`;
  const env = { ...process.env, USERPROFILE: temp, HOME: temp,
    XTERM_FOCUS_TEST_ROOT: temp, XTERM_FOCUS_TEST_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = spawn(process.execPath, ['server/index.js', '--no-open', '--port', String(port)],
    { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' });
  let electron;
  try {
    await until(() => new Promise(resolve => http.get(url, response => {
      response.resume(); resolve(response.statusCode === 200);
    }).on('error', () => resolve(false))), 'Isolated engine did not start');
    await new Promise((resolve, reject) => {
      electron = spawn(require('electron'), [__filename, '--focus-fixture'],
        { cwd: ROOT, env: { ...env, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME },
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      electron.stdout.on('data', chunk => { output += chunk; });
      electron.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => { electron.kill(); reject(new Error(`Electron input test timed out: ${output}`)); }, 60000);
      electron.once('error', error => { clearTimeout(timeout); reject(error); });
      electron.once('exit', code => {
        clearTimeout(timeout);
        if (code !== 0 || !output.includes('✓ Electron input:')) reject(new Error(output || `Electron exited ${code}`));
        else { console.log(output.slice(output.indexOf('✓ Electron input:')).split('\n')[0]); resolve(); }
      });
    });
  } finally {
    if (electron && electron.exitCode === null) electron.kill();
    server.kill();
    await sleep(500);
    assert.strictEqual(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert(path.basename(temp).startsWith('xterm-electron-input-'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.versions.electron) {
  runElectron().catch(error => { console.error(error.stack); require('electron').app.exit(1); });
} else {
  runNode().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
