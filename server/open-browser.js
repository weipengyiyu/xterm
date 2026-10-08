'use strict';

const { spawnSync } = require('child_process');

function isLocalHttp(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
    if (/[&|<>^"`%]/.test(url)) return false;
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (!isLocalHttp(url)) {
    console.error(`Cannot open browser: refusing non-local URL ${url}`);
    return false;
  }
  if (process.platform === 'win32') {
    // `start` returns as soon as the default browser is launched, and it
    // gives that window focus. rundll32 is the fallback when cmd is unavailable.
    const started = spawnSync('cmd.exe', ['/d', '/c', 'start', '""', url], {
      windowsHide: true, timeout: 10000,
    });
    if (!started.error && started.status === 0) return true;
    const fallback = spawnSync('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      windowsHide: true, timeout: 10000,
    });
    if (fallback.error || fallback.status !== 0) {
      console.error(`Cannot open browser${fallback.error ? `: ${fallback.error.message}` : ''}. Open ${url} manually.`);
      return false;
    }
    return true;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const result = spawnSync(command, [url], { stdio: 'ignore', timeout: 10000 });
  if (result.error || result.status !== 0) {
    console.error(`Cannot open browser${result.error ? `: ${result.error.message}` : ''}. Open ${url} manually.`);
    return false;
  }
  return true;
}

module.exports = { openBrowser };
