'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { resolveRustDesk, launchRustDeskTray } = require('./rustdesk-launcher');

const SERVICE_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$s = Get-Service | Where-Object { $_.ServiceName -eq 'RustDesk' }
if ($null -eq $s) { @{ installed = $false; running = $false; state = 'NotInstalled'; startup = '' } | ConvertTo-Json -Compress }
else {
  $clientPath = ''
  $imagePath = Get-ItemPropertyValue -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\RustDesk' -Name ImagePath
  $imagePath = [Environment]::ExpandEnvironmentVariables($imagePath)
  if ($imagePath -match '^(?:"([^"]+)"|(.+?\\.exe)(?:\\s|$))') {
    if ($Matches[1]) { $clientPath = $Matches[1] } else { $clientPath = $Matches[2] }
  }
  @{ installed = $true; running = ($s.Status -eq 'Running'); state = [string]$s.Status; startup = [string]$s.StartType; clientPath = $clientPath } | ConvertTo-Json -Compress
}
`;

function runPowerShell(script, options = {}) {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, shell: false, timeout: options.timeout || 15000, maxBuffer: 128 * 1024 },
      (error, stdout) => {
        if (error) return reject(new Error(error.killed
          ? 'RustDesk 服务操作超时，请刷新状态后重试'
          : '无法操作 RustDesk 服务，请确认管理员授权并刷新状态后重试'));
        resolve(stdout.trim());
      });
  });
}

// The path is data inside a single-quoted PowerShell literal; never shell code.
const psLiteral = value => "'" + value.replace(/'/g, "''") + "'";

function serviceChangeScript(enabled, clientPath) {
  const operation = `
$ErrorActionPreference = 'Stop'
try {
  $s = Get-Service | Where-Object { $_.ServiceName -eq 'RustDesk' }
  ${enabled ? `if ($null -eq $s) {
    $installer = Start-Process -FilePath ${psLiteral(clientPath)} -ArgumentList '--silent-install' -WindowStyle Hidden -PassThru
    if (-not $installer.WaitForExit(60000)) { throw 'RustDesk installation timed out' }
    if ($installer.ExitCode -ne 0) { throw 'RustDesk installation failed' }
    $s = Get-Service -Name 'RustDesk'
  }
  Set-Service -Name 'RustDesk' -StartupType Automatic
  Start-Service -Name 'RustDesk'
  (Get-Service -Name 'RustDesk').WaitForStatus('Running', [TimeSpan]::FromSeconds(30))` : `if ($null -ne $s) {
    Stop-Service -Name 'RustDesk'
    (Get-Service -Name 'RustDesk').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    Set-Service -Name 'RustDesk' -StartupType Disabled
  }`}
  exit 0
} catch { exit 1 }
`;
  // Run only the service operation with elevation; xterm stays unelevated.
  const encoded = Buffer.from(operation, 'utf16le').toString('base64');
  return `$ErrorActionPreference = 'Stop'
try {
  $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded}')
  exit $p.ExitCode
} catch { exit 1 }`;
}

function createRustDeskServiceController(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.runPowerShell || runPowerShell;
  const launchTray = options.launchRustDeskTray || launchRustDeskTray;
  let busy = false;
  async function status() {
    if (platform !== 'win32') return { supported: false, installed: false, running: false, busy: false };
    const result = JSON.parse(await run(SERVICE_QUERY));
    if (typeof result.installed !== 'boolean' || typeof result.running !== 'boolean'
        || typeof result.state !== 'string') throw new Error('无法读取 RustDesk 服务状态');
    return { ...result, supported: true, busy };
  }
  async function setEnabled(enabled, clientPath = '') {
    if (typeof enabled !== 'boolean') throw new Error('RustDesk 服务开关参数无效');
    if (platform !== 'win32') throw new Error('RustDesk 后台服务开关目前仅支持 Windows');
    if (busy) throw new Error('RustDesk 服务正在操作中，请稍后刷新状态');
    busy = true;
    try {
      const before = await status();
      let executable = '';
      if (enabled && !before.installed) {
        executable = await (options.resolveRustDesk || resolveRustDesk)(clientPath);
        if (!executable) throw new Error('未找到 RustDesk 客户端，请选择客户端后重试');
      }
      const alreadySet = enabled
        ? before.running && before.startup === 'Automatic'
        : !before.installed || (before.state === 'Stopped' && before.startup === 'Disabled');
      if (!alreadySet) await run(serviceChangeScript(enabled, executable), { timeout: 120000 });
      const after = await status();
      if (enabled ? !after.running || after.startup !== 'Automatic'
        : after.installed && (after.state !== 'Stopped' || after.startup !== 'Disabled')) {
        throw new Error('RustDesk 服务未达到预期状态，请检查管理员授权后重试');
      }
      // A Windows service runs outside the interactive desktop. Launch its
      // tray in xterm's user session, using the registered service executable.
      let trayError = '';
      if (enabled) {
        try { await launchTray(after.clientPath || clientPath || executable); }
        catch (error) { trayError = error.message; }
      }
      return { ...after, busy: false, ...(trayError ? { trayError } : {}) };
    } finally { busy = false; }
  }
  async function showTray() {
    if (busy) throw new Error('RustDesk 服务正在操作中，请稍后重试');
    const service = await status();
    if (!service.supported) throw new Error('RustDesk 托盘程序目前仅支持 Windows');
    if (!service.running) throw new Error('请先开启 RustDesk 后台服务');
    await launchTray(service.clientPath || '');
    return service;
  }
  return { status, setEnabled, showTray };
}

module.exports = { createRustDeskServiceController, serviceChangeScript, SERVICE_QUERY };
