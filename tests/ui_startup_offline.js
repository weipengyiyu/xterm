'use strict';

// Use the installed Chrome and the real launcher/server. Hold all external
// requests indefinitely so startup cannot accidentally depend on Internet CSS.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('./puppeteer_test');
const browserPath = require('./browser_path')();
const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-browser-startup-'));
const profile = path.join(sandbox, 'server-profile');
const artifacts = path.join(root, '.tools', 'verification');
const env = { ...process.env, USERPROFILE: profile, HOME: profile };
fs.mkdirSync(profile);
fs.mkdirSync(artifacts, { recursive: true });
const report = { browserPath, externalRequests: [], websocketAttempts: 0, steps: [] };

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function getInfo(base) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/launcher-info`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'launch.js'), ...args], {
      cwd: sandbox, env, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Launcher timed out: ${output}`)); }, 15000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      if (code !== 0) reject(new Error(output)); else resolve();
    });
  });
}

async function connected(page) {
  await page.waitForFunction(() => document.getElementById('conn-status-text')?.textContent === '服务器已连接', { timeout: 5000 });
  await page.waitForFunction(() => typeof localShells !== 'undefined' && localShells.some(shell => shell.id === 'cmd' && shell.available), { timeout: 5000 });
}

async function command(page, marker) {
  // xterm's hidden helper textarea has no stable clickable rectangle. Focus
  // through its public API before delivering real keyboard events.
  await page.evaluate(() => {
    const tab = tabs.find(tab => tab.cfg.type === 'local' && tab.state === 'connected');
    if (!tab?.term) throw new Error('Connected local terminal is missing');
    tab.term.focus();
  });
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(marker => tabs.some(tab => {
    const buffer = tab.term?.buffer.active;
    if (!buffer) return false;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer.getLine(i)?.translateToString(true).trim() === marker) return true;
    }
    return false;
  }), { timeout: 5000 }, marker);
}

(async () => {
  let browser;
  let service;
  let page;
  let base;
  const errors = [];
  try {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    await launch(['--port', String(port), '--no-open']);
    service = await getInfo(base);
    report.steps.push('Cold launcher HTTP + WebSocket session-list verification passed');
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: path.join(sandbox, 'browser-profile') });
    report.browserVersion = await browser.version();
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === String(port)) {
        request.continue().catch(() => {});
      } else if (url.protocol === 'http:' || url.protocol === 'https:') {
        report.externalRequests.push({ host: url.hostname, resourceType: request.resourceType() });
        // Deliberately never complete this request; failure must not time out
        // before the browser has a chance to expose a render-blocking asset.
      } else request.continue().catch(() => {});
    });
    page.on('pageerror', error => errors.push(error.message));
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    client.on('Network.webSocketCreated', () => { report.websocketAttempts++; });
    page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await page.waitForSelector('#conn-status-text', { timeout: 5000 });
    await connected(page);
    report.steps.push('Browser connected while all external network requests were held');
    assert.deepStrictEqual(report.externalRequests, [], 'the local tool must not load remote startup assets');
    await page.click('#btn-local');
    await page.waitForSelector('#menu-local:not(.hidden) button');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('#menu-local button')].find(button => button.textContent === 'CMD');
      if (!button) throw new Error('CMD menu entry is missing');
      button.click();
    });
    await page.waitForFunction(() => tabs.some(tab => tab.cfg.type === 'local' && tab.state === 'connected'), { timeout: 5000 });
    await command(page, 'XTERM_OFFLINE_START_OK');
    report.steps.push('Real CMD input/output passed');
    const windowId = await page.evaluate(() => sessionStorage.getItem('xterm.window.id'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await connected(page);
    await page.waitForFunction(() => tabs.some(tab => tab.cfg.type === 'local' && tab.state === 'connected'), { timeout: 5000 });
    assert.strictEqual(await page.evaluate(() => sessionStorage.getItem('xterm.window.id')), windowId);
    await command(page, 'XTERM_OFFLINE_REFRESH_OK');
    report.steps.push('Refresh reattached the same window and real CMD input/output passed');
    await launch(['--port', String(port), '--no-open']);
    assert.strictEqual((await getInfo(base)).pid, service.pid, 'relaunch must preserve the running server');
    report.steps.push('Relaunch preserved the server PID and active terminal');
    assert.deepStrictEqual(errors, []);
    await page.screenshot({ path: path.join(artifacts, 'offline-startup-success.png'), fullPage: true });
    report.passed = true;
    console.log('✅ Installed Chrome: cold startup, no external network, WebSocket, real CMD, refresh and relaunch passed');
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    if (page) {
      try {
        report.status = await page.$eval('#conn-status-text', element => element.textContent);
        await page.screenshot({ path: path.join(artifacts, 'offline-startup-failure.png'), fullPage: true });
      } catch {}
    }
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(artifacts, 'offline-startup-report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    if (service) {
      try { process.kill(service.pid); } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.strictEqual(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
    assert(path.basename(sandbox).startsWith('xterm-browser-startup-'));
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
