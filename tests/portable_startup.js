'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
let completed = false;
process.once('beforeExit', () => {
  if (!completed) { console.error('Portable verification ended before all checks completed'); process.exitCode = 1; }
});

function run(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Portable startup timed out: ${output}`)); }, 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, output });
    });
  });
}
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

(async () => {
  if (process.platform !== 'win32') throw new Error('This desktop portable smoke test currently targets Windows');
  const archives = fs.readdirSync(path.join(root, 'dist')).filter(name => /^xterm-win32-x64-portable-\d+\.zip$/.test(name)).sort();
  const archive = process.env.XTERM_PORTABLE_ZIP || path.join(root, 'dist', archives.at(-1) || 'missing.zip');
  assert(fs.existsSync(archive), 'Build the portable ZIP first');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-portable-test-'));
  const moved = path.join(sandbox, '移动 目录 & offline');
  const profile = path.join(sandbox, 'profile');
  fs.mkdirSync(profile);
  const system32 = path.join(process.env.SystemRoot, 'System32');
  const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = {
    ...process.env, USERPROFILE: profile, HOME: profile,
    PATH: system32, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1', npm_config_offline: 'true',
    XTERM_PROOF: path.join(sandbox, 'connected.txt'),
  };
  delete env.XTERM_NODE;
  delete env.ELECTRON_RUN_AS_NODE;
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  let occupiedDefault;
  const foreignSockets = new Set();
  try {
    const extraction = await run(powershell, ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)}, ${quote(moved)})`], { env, cwd: sandbox });
    assert.strictEqual(extraction.code, 0, extraction.output);
    const app = path.join(moved, 'xterm-win32-x64-portable');
    const node = path.join(app, 'runtime', 'node.exe');
    const port = await freePort();
    const start = await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'launch.ps1'), '-Port', String(port)], { env, cwd: sandbox });
    assert.strictEqual(start.code, 0, start.output);
    assert.match(fs.readFileSync(env.XTERM_PROOF, 'utf8'), /已连接|Server connected/);
    console.log('✓ Extracted ZIP, relocated Chinese/space/& path, no system Node, offline desktop connected');
    // The desktop test mode exits after connection; wait for its owned engine.
    await new Promise(resolve => setTimeout(resolve, 1500));
    fs.unlinkSync(env.XTERM_PROOF);
    const batch = await run(path.join(system32, 'cmd.exe'), ['/d', '/s', '/c', `""${path.join(app, 'run.bat')}" --port ${await freePort()}"`], {
      env, cwd: sandbox, windowsVerbatimArguments: true,
    });
    assert.strictEqual(batch.code, 0, batch.output);
    assert.match(fs.readFileSync(env.XTERM_PROOF, 'utf8'), /已连接|Server connected/);
    await new Promise(resolve => setTimeout(resolve, 1500));
    fs.unlinkSync(env.XTERM_PROOF);
    // Test automatic fallback without interfering with any existing listener.
    occupiedDefault = net.createServer(socket => {
      foreignSockets.add(socket);
      socket.once('close', () => foreignSockets.delete(socket));
      socket.on('error', () => {});
      socket.resume();
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}');
    });
    const reserved = await new Promise(resolve => {
      occupiedDefault.once('error', () => resolve(false));
      occupiedDefault.listen(8787, '127.0.0.1', () => resolve(true));
    });
    if (!reserved) occupiedDefault = null;
    const vbs = await run(path.join(system32, 'cscript.exe'), ['//nologo', path.join(app, 'launcher.vbs')], { env, cwd: sandbox });
    assert.strictEqual(vbs.code, 0, vbs.output);
    assert.match(fs.readFileSync(env.XTERM_PROOF, 'utf8'), /已连接|Server connected/);
    if (occupiedDefault) {
      assert.match(fs.readFileSync(path.join(profile, '.xterm', 'logs', 'launcher.log'), 'utf8'), /Default port 8787 is unavailable; using/);
      for (const socket of foreignSockets) socket.destroy();
      await new Promise(resolve => occupiedDefault.close(resolve));
      occupiedDefault = null;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    console.log('✓ PowerShell, BAT and VBS launchers use bundled Node; default port collision recovery');
    const native = await run(node, ['-e', `
      const assert = require('assert');
      require('serialport').SerialPort.list().then(list => {
        assert(Array.isArray(list));
        const pty = require('node-pty').spawn(process.env.ComSpec, ['/d', '/q'], { env: process.env });
        let output = '';
        const timer = setTimeout(() => { console.error('ConPTY output timed out: ' + output); pty.kill(); process.exit(1); }, 10000);
        pty.onData(data => {
          output += data;
          if (output.includes('XTERM_PORTABLE_PTY_OK')) {
            clearTimeout(timer);
            console.log('serialport + ConPTY passed');
            pty.kill();
            setTimeout(() => process.exit(0), 300);
          }
        });
        pty.write('echo XTERM_PORTABLE_PTY_OK\\r\\n');
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `], { env, cwd: app });
    assert.strictEqual(native.code, 0, native.output);
    assert.match(native.output, /serialport \+ ConPTY passed/);
    console.log('✓ Bundled native serialport enumeration and actual ConPTY shell output');
    const server = path.join(app, 'server', 'index.js');
    const original = fs.readFileSync(server);
    try {
      fs.writeFileSync(server, 'console.error("PORTABLE_FAILURE_DETAIL"); process.exit(7);');
      const failed = await run(node, [path.join(app, 'scripts', 'launch.js'), '--port', String(await freePort())], { env, cwd: sandbox });
      assert.strictEqual(failed.code, 1, failed.output);
      assert.match(failed.output, /PORTABLE_FAILURE_DETAIL/);
      console.log('✓ Desktop engine failure returns nonzero and preserves the actual error');
    } finally { fs.writeFileSync(server, original); }
    console.log('Portable ZIP startup smoke tests passed');
    completed = true;
  } finally {
    for (const socket of foreignSockets) socket.destroy();
    if (occupiedDefault) await new Promise(resolve => occupiedDefault.close(resolve));
    assert.strictEqual(path.dirname(sandbox), os.tmpdir());
    assert(path.basename(sandbox).startsWith('xterm-portable-test-'));
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
