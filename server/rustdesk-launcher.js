'use strict';

const fs = require('fs/promises');
const { constants } = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function normalizeRustDeskId(value) {
  const id = typeof value === 'string' ? value.trim().replace(/^(\d[\d ]*)$/, text => text.replace(/ /g, '')) : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new Error('请填写有效的 RustDesk 设备 ID 或 IP 地址');
  }
  return id;
}

async function resolveRustDesk(clientPath = '', options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const root = options.root || path.resolve(__dirname, '..');
  const executable = platform === 'win32' ? 'rustdesk.exe' : 'rustdesk';
  const explicit = String(clientPath || env.XTERM_RUSTDESK || '').trim();
  const candidates = explicit ? [explicit] : platform === 'win32' ? [
    path.join(root, 'tools', 'rustdesk', executable),
    ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map(dir => path.join(dir, 'RustDesk', executable)),
    ...[env.LOCALAPPDATA].filter(Boolean).map(dir => path.join(dir, 'Programs', 'RustDesk', executable)),
  ] : [
    '/Applications/RustDesk.app/Contents/MacOS/RustDesk',
    '/usr/bin/rustdesk', '/usr/local/bin/rustdesk',
  ];
  if (!explicit) {
    candidates.push(...String(env.PATH || '').split(path.delimiter).filter(Boolean)
      .map(dir => path.join(dir.replace(/^"|"$/g, ''), executable)));
  }
  for (const candidate of candidates) {
    const name = path.basename(candidate);
    if (!path.isAbsolute(candidate) || candidate.includes('\0')
        || !(platform === 'win32' ? /^rustdesk\.exe$/i : /^rustdesk$/i).test(name)) {
      if (explicit) throw new Error('请选择 RustDesk 客户端可执行文件的完整路径');
      continue;
    }
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  if (explicit) throw new Error('RustDesk 客户端路径不存在或不可执行，请检查路径');
  return '';
}

async function launchRustDesk(config, options = {}) {
  const deviceId = normalizeRustDeskId(config?.deviceId);
  const clientPath = await resolveRustDesk(config?.clientPath, options);
  if (!clientPath) throw new Error('未找到 RustDesk 客户端，请安装 RustDesk 或在会话中填写客户端路径');
  const start = options.spawn || spawn;
  await new Promise((resolve, reject) => {
    const child = start(clientPath, ['--connect', deviceId], {
      cwd: path.dirname(clientPath), shell: false, detached: true,
      windowsHide: false, stdio: 'ignore',
    });
    child.once('error', () => reject(new Error('无法启动 RustDesk 客户端，请检查文件和运行权限')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { deviceId, clientPath };
}

module.exports = { normalizeRustDeskId, resolveRustDesk, launchRustDesk };
