'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

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
  const args = ['install', '--no-audit', '--no-fund', '--fetch-retries=1', '--fetch-timeout=30000'];
  let deadProxy = false;
  for (const key of Object.keys(env).filter(key => /^(https?_proxy|all_proxy|npm_config_(https_)?proxy)$/i.test(key))) {
    if (env[key] && !(await reachable(env[key]))) { delete env[key]; deadProxy = true; }
  }
  for (const key of ['proxy', 'https-proxy']) {
    const config = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['config', 'get', key], {
      cwd: root, env, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 10000,
    });
    const value = String(config.stdout || '').trim();
    if (value && value !== 'null' && !(await reachable(value))) deadProxy = true;
  }
  if (deadProxy) {
    // Override only this install; never change the user's global npm settings.
    args.push('--proxy=null', '--https-proxy=null');
    env.npm_config_proxy = '';
    env.npm_config_https_proxy = '';
    log('Ignoring an unreachable local proxy for this dependency installation.');
  }
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
  const run = () => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root, env, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32', timeout: 300000,
  });
  let result = run();
  // GitHub can be inaccessible even when the npm registry works. Keep the
  // official checksum validation and respect an explicitly configured mirror.
  if ((result.error || result.status !== 0) && !env.ELECTRON_MIRROR && desktop) {
    env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
    log('Retrying Electron download using the mirror documented by Electron.');
    result = run();
  }
  // npm can leave an installed package whose binary postinstall never ran.
  if (!result.error && result.status === 0 && desktop && check(root, true)) {
    const installer = path.join(root, 'node_modules', 'electron', 'install.js');
    if (fs.existsSync(installer)) result = spawnSync(process.execPath, [installer], {
      cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 300000,
    });
    if ((result.error || result.status !== 0) && !env.ELECTRON_MIRROR && fs.existsSync(installer)) {
      env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
      log('Retrying the missing Electron binary using the documented mirror.');
      result = spawnSync(process.execPath, [installer], {
        cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 300000,
      });
    }
  }
  if (!result.error && result.status === 0 && check(root, desktop)) {
    // A copied dependency tree or a changed Node ABI can require native rebuilds
    // even when npm reports all packages as already installed.
    result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['rebuild'], {
      cwd: root, env, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32', timeout: 300000,
    });
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

module.exports = { probe, check, reachable, installEnvironment, ensureInstalled };
if (require.main === module && process.argv[2] === '--probe') {
  try { probe(process.argv[3], process.argv[4] === 'desktop'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
