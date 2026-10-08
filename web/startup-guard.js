// Recover an incomplete first load without touching the server or its sessions.
(() => {
  let initialized = false;
  let connected = false;
  let finished = false;
  let retryTimer;
  const retryKey = '_startupRetry';
  const freshKey = '_startupFresh';
  const ready = () => {
    if (!initialized || !connected) return;
    finished = true;
    clearTimeout(watchdog);
    clearTimeout(retryTimer);
    const url = new URL(location.href);
    if (url.searchParams.has(retryKey)) {
      url.searchParams.delete(retryKey);
      url.searchParams.delete(freshKey);
      history.replaceState(null, '', url);
    }
  };
  const recover = () => {
    if (finished) return;
    const url = new URL(location.href);
    if (!url.searchParams.has(retryKey)) {
      url.searchParams.set(retryKey, '1');
      url.searchParams.set(freshKey, String(Date.now()));
      location.replace(url.href);
      return;
    }
    finished = true;
    clearTimeout(watchdog);
    const status = document.getElementById('conn-status-text');
    if (status) status.textContent = '界面初始化失败，请刷新页面或查看启动日志';
    const dot = document.getElementById('conn-status');
    if (dot) dot.className = 'status-dot err';
  };
  document.addEventListener('sshterm:initialized', () => { initialized = true; ready(); });
  document.addEventListener('sshterm:connected', () => { connected = true; ready(); });
  window.addEventListener('error', event => {
    if (finished) return;
    const scriptFailed = event.target instanceof HTMLScriptElement;
    const appFailed = event instanceof ErrorEvent && /\/(?:app(?:\.main)?\.js|js\/)/.test(event.filename || '');
    if (scriptFailed || appFailed) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(recover, 250);
    }
  }, true);
  const watchdog = setTimeout(() => {
    // A running app handles network failures with its own reconnect loop.
    if (!initialized) recover();
  }, 6000);
})();
