'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

function npmCommand(args) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(cli) ? { command: process.execPath, args: [cli, ...args], shell: false }
    : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, shell: process.platform === 'win32' };
}
function runInstaller(command, args, options = {}) {
  return new Promise(resolve => {
    const { timeout = 300000, ...other } = options;
    // Do not merge the original environment back in: deleted dead proxies must stay deleted.
    const env = { ...(other.env || process.env) };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const searchPath = env.PATH || env[pathKey] || '';
    for (const key of Object.keys(env).filter(key => key.toLowerCase() === 'path')) delete env[key];
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${searchPath}`;
    const child = spawn(command, args, { ...other, env, windowsHide: true, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    }, timeout);
    child.once('error', error => { clearTimeout(timer); resolve({ error, status: 1 }); });
    child.once('exit', status => { clearTimeout(timer); resolve({ status, error: timedOut ? new Error('Installation timed out') : null }); });
  });
}

function probe(root, desktop = true) {
  const portable = path.join(root, 'portable.json');
  if (fs.existsSync(portable)) {
    const target = JSON.parse(fs.readFileSync(portable, 'utf8'));
    if (target.platform !== process.platform || target.arch !== process.arch || target.nodeAbi !== process.versions.modules) {
      throw new Error(`This portable package requires ${target.platform}/${target.arch}, Node ABI ${target.nodeAbi}`);
    }
  }
  const { createRequire } = require('module');
  const load = createRequire(path.join(root, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (!desktop && name === 'electron') continue;
    const manifest = path.join(root, 'node_modules', name, 'package.json');
    if (!fs.existsSync(manifest)) throw new Error(`Missing dependency: ${name}`);
    // Resolve the executable/asset entry as well as the package metadata.
    if (name !== 'electron') load.resolve(name);
  }
  for (const name of ['ws', 'ssh2', 'serialport', 'node-pty']) {
    if (pkg.dependencies && pkg.dependencies[name]) load(name);
  }
  if (desktop) {
    const executable = load('electron');
    if (typeof executable !== 'string' || !fs.existsSync(executable)) {
      throw new Error('Electron executable is missing');
    }
  }
}

function check(root, desktop) {
  const child = spawnSync(process.execPath, [__filename, '--probe', root, desktop ? 'desktop' : 'server'], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  return child.status === 0 ? '' : String(child.stderr || child.error || 'Dependency probe failed').trim();
}

function reachable(proxy) {
  return new Promise(resolve => {
    let url;
    try { url = new URL(proxy); } catch { resolve(true); return; }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { resolve(true); return; }
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function installEnvironment(root, log = console.log) {
  const env = { ...process.env };
  const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts',
    `--ignore-scripts=${process.platform === 'win32' ? 'true' : 'false'}`, '--fetch-retries=1', '--fetch-timeout=30000',
    '--registry=https://registry.npmjs.org', '--replace-registry-host=always'];
  let deadProxy = false;
  for (const key of Object.keys(env).filter(key => /^(https?_proxy|all_proxy|npm_config_(https_)?proxy)$/i.test(key))) {
    if (env[key] && !(await reachable(env[key]))) { delete env[key]; deadProxy = true; }
  }
  for (const key of ['proxy', 'https-proxy']) {
    const npm = npmCommand(['config', 'get', key]);
    const config = spawnSync(npm.command, npm.args, {
      cwd: root, env, encoding: 'utf8', windowsHide: true, shell: npm.shell, timeout: 10000,
    });
    const value = String(config.stdout || '').trim();
    if (value && value !== 'null') {
      if (!(await reachable(value))) deadProxy = true;
      else env[key === 'https-proxy' ? 'HTTPS_PROXY' : 'HTTP_PROXY'] = value;
    }
  }
  if (deadProxy) {
    // Override only this install; never change the user's global npm settings.
    args.push('--proxy=null', '--https-proxy=null');
    env.npm_config_proxy = '';
    env.npm_config_https_proxy = '';
    log('Ignoring an unreachable local proxy for this dependency installation.');
  }
  if (env.HTTPS_PROXY || env.HTTP_PROXY) env.ELECTRON_GET_USE_PROXY = '1';
  return { env, args };
}

async function repairInstalled(root, desktop, log = console.log) {
  const failure = check(root, desktop);
  if (!failure) return;
  if (fs.existsSync(path.join(root, 'portable.json'))) {
    throw new Error(`Portable runtime is damaged or incompatible. Extract the complete matching package again. ${failure}`);
  }
  log(`Repairing incomplete dependencies: ${failure}`);
  const { env, args } = await installEnvironment(root, log);
  const npmEnv = { ...env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
  const run = installArgs => {
    const command = npmCommand(installArgs);
    return runInstaller(command.command, command.args, { cwd: root, env: npmEnv, shell: command.shell });
  };
  let result = await run(args);
  if (result.error || result.status !== 0) {
    log('Retrying dependency download using the npm mirror.');
    result = await run([...args, '--registry=https://registry.npmmirror.com']);
  }
  // Windows packages ship native prebuilds. Avoid compiler hooks and their
  // cmd shims, which break when the repository path contains an ampersand.
  if (!result.error && result.status === 0 && process.platform === 'win32') {
    const installer = path.join(root, 'node_modules', 'node-pty', 'scripts', 'post-install.js');
    if (fs.existsSync(installer)) {
      log('Preparing prebuilt Windows terminal components.');
      result = await runInstaller(process.execPath, [installer], { cwd: root, env: npmEnv });
    }
  }
  if (!result.error && result.status === 0 && desktop) {
    result = await runInstaller(process.execPath, [path.join(__dirname, 'install-electron.js'), root], { cwd: root, env });
  }
  if (!result.error && result.status === 0 && process.platform !== 'win32' && check(root, desktop)) {
    result = await run(['rebuild', '--foreground-scripts', '--ignore-scripts=false']);
  }
  const remaining = check(root, desktop);
  if (result.error || result.status !== 0 || remaining) {
    throw new Error(`Dependency repair failed: ${remaining || result.error || result.status}. Check network/proxy settings, or use the offline portable package.`);
  }
}

async function ensureInstalled(root, desktop, log = console.log) {
  if (!check(root, desktop)) return;
  if (fs.existsSync(path.join(root, 'portable.json'))) return repairInstalled(root, desktop, log);
  const lock = path.join(root, '.xterm-install.lock');
  const deadline = Date.now() + 600000;
  let owned = false;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      owned = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let live = false;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); live = true; } catch (error) { live = error.code === 'EPERM'; }
        } else live = Date.now() - fs.statSync(lock).mtimeMs < 2000;
      } catch { live = true; }
      if (!live) { try { fs.unlinkSync(lock); } catch {} continue; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  if (!owned) throw new Error('Another dependency installation is still running. Try again after it finishes.');
  try { await repairInstalled(root, desktop, log); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

module.exports = { probe, check, reachable, installEnvironment, ensureInstalled, npmCommand, runInstaller };
if (require.main === module && process.argv[2] === '--probe') {
  try { probe(process.argv[3], process.argv[4] === 'desktop'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
