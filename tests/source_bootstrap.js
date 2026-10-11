'use strict';
// Exercise a downloaded source ZIP, with no system Node, dependencies or cache.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-source-bootstrap-'));
const source = path.join(sandbox, 'source');
const project = path.join(sandbox, '下载源码 中文 & app');
const profile = path.join(sandbox, 'profile');
const proof = path.join(sandbox, 'connected.txt');
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const env = { ...process.env, USERPROFILE: profile, HOME: profile, PATH: path.join(process.env.SystemRoot, 'System32'),
  XTERM_NO_SYSTEM_NODE: '1', XTERM_PROOF: proof, XTERM_TEST_NO_DIALOG: '1',
  npm_config_cache: path.join(sandbox, 'npm-cache'), npm_config_userconfig: path.join(sandbox, 'npmrc'),
  electron_config_cache: path.join(sandbox, 'electron-cache'),
  HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1' };
for (const key of ['ELECTRON_MIRROR', 'ELECTRON_RUN_AS_NODE', 'XTERM_STARTUP_REQUEST', 'npm_config_offline']) delete env[key];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('Source bootstrap verification did not complete'); process.exitCode = 1; } });

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: sandbox, env, windowsHide: true, ...options });
    child.stdin.end();
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; process.stderr.write(data); });
    const timer = setTimeout(() => {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      reject(new Error(`Source startup timed out: ${output.slice(-4000)}`));
    }, 600000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); resolve({ code, output }); });
  });
}
const quote = value => `'${value.replace(/'/g, "''")}'`;
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function diagnostic() {
  const logs = path.join(profile, '.xterm', 'logs');
  return ['launcher.log', 'desktop.log', 'server-stderr.log'].map(name => {
    const file = path.join(logs, name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-6000) : '';
  }).join('\n');
}

(async () => {
  try {
    assert.strictEqual(process.platform, 'win32', 'this test exercises Windows double-click startup');
    fs.mkdirSync(profile);
    const npmrc = 'proxy=http://127.0.0.1:1\nhttps-proxy=http://127.0.0.1:1\nignore-scripts=true\n';
    fs.writeFileSync(env.npm_config_userconfig, npmrc);
    const archive = path.join(sandbox, 'repository.zip');
    if (process.env.XTERM_SOURCE_ZIP) fs.copyFileSync(process.env.XTERM_SOURCE_ZIP, archive);
    else {
      fs.mkdirSync(source);
      const files = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
      assert.strictEqual(files.status, 0);
      for (const file of files.stdout.split('\0').filter(Boolean)) {
        const target = path.join(source, file);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file), target);
      }
      const zipped = await run(powershell, ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(source)}, ${quote(archive)})`]);
      assert.strictEqual(zipped.code, 0, zipped.output);
    }
    const extracted = await run(powershell, ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)}, ${quote(project)})`]);
    assert.strictEqual(extracted.code, 0, extracted.output);
    for (const entry of ['node_modules', '.runtime', 'runtime', 'portable.json']) assert(!fs.existsSync(path.join(project, entry)), `fresh source unexpectedly contains ${entry}`);
    const port = await freePort();
    const cold = await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c',
      `""${path.join(project, '启动.cmd')}" --port ${port}"`], { windowsVerbatimArguments: true });
    assert.strictEqual(cold.code, 0, cold.output + diagnostic());
    // The double-click CMD entry now hands off to wscript and exits immediately.
    // Readiness is still the actual connected desktop, not the handoff's exit.
    const readyDeadline = Date.now() + 600000;
    while (!fs.existsSync(proof) && Date.now() < readyDeadline) await sleep(200);
    assert(fs.existsSync(proof), diagnostic());
    assert.match(fs.readFileSync(proof, 'utf8'), /已连接|Server connected/, diagnostic());
    assert(fs.existsSync(path.join(project, '.runtime', 'node-v24.21.0-win-' + process.arch, 'node.exe')));
    assert(fs.existsSync(path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe')));
    assert(!/gyp ERR|MSBuild\.exe|Visual Studio.*required/i.test(cold.output), 'source startup must not require a compiler');
    assert.strictEqual(fs.readFileSync(env.npm_config_userconfig, 'utf8'), npmrc, 'user npm settings changed');
    console.log('✓ Fresh source ZIP: no system Node, no dependencies, empty caches, dead proxy, Chinese/space/ampersand path');
    const managedNode = path.join(project, '.runtime', 'node-v24.21.0-win-' + process.arch, 'node.exe');
    const native = await run(managedNode, ['-e', `
      const assert = require('assert');
      require('serialport').SerialPort.list().then(list => {
        assert(Array.isArray(list));
        const pty = require('node-pty').spawn(process.env.ComSpec, ['/d', '/q'], { env: process.env });
        let output = '', ready = false;
        const timer = setTimeout(() => { console.error('Native shell timed out: ' + output); pty.kill(); process.exit(1); }, 10000);
        pty.onData(data => {
          output += data;
          if (!ready && /(?:\\r\\n|\\n|\\r)XTERM_SOURCE_NATIVE_OK(?:\\r\\n|\\n|\\r|\\x1b\\[)/.test(output)) {
            ready = true; pty.write('exit\\r');
          }
        });
        pty.onExit(result => {
          clearTimeout(timer);
          if (!ready || result.exitCode !== 0) { console.error('Native shell exited without successful output'); process.exitCode = 1; }
          else console.log('serialport + real CMD output passed');
          // ConPTY's worker can retain a handle after the shell exits.
          setTimeout(() => process.exit(process.exitCode || 0), 300);
        });
        pty.write('echo XTERM_SOURCE_NATIVE_OK\\r');
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: project });
    assert.strictEqual(native.code, 0, native.output);
    assert.match(native.output, /serialport \+ real CMD output passed/);
    await sleep(1800); fs.unlinkSync(proof);
    const warm = await run(path.join(process.env.SystemRoot, 'System32', 'cscript.exe'),
      ['//nologo', path.join(project, 'launcher.vbs'), '--port', String(port)],
      { env: { ...env, npm_config_offline: 'true', ELECTRON_MIRROR: 'http://127.0.0.1:1/' } });
    assert.strictEqual(warm.code, 0, warm.output + diagnostic());
    assert.match(fs.readFileSync(proof, 'utf8'), /已连接|Server connected/, diagnostic());
    assert(!fs.existsSync(path.join(project, '--allow-file-access-from-files')));
    console.log('✓ Actual VBS entry: cached runtime started with dependency downloads disabled');
    completed = true;
    console.log('Source ZIP double-click bootstrap verification passed');
  } finally {
    await sleep(1800);
    // Every process ID below is recorded by this isolated test profile only.
    const desktopLog = path.join(profile, '.xterm', 'logs', 'desktop.log');
    if (fs.existsSync(desktopLog)) for (const match of fs.readFileSync(desktopLog, 'utf8').matchAll(/\[(\d+)\] Single instance lock: true/g)) {
      spawnSync('taskkill.exe', ['/PID', match[1], '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    assert.strictEqual(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
    assert(path.basename(sandbox).startsWith('xterm-source-bootstrap-'));
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
