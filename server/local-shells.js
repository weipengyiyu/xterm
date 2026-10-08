'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHELL_DEFS = [
  { id: 'powershell', label: 'PowerShell', names: ['powershell.exe'], args: ['-NoLogo'] },
  { id: 'pwsh', label: 'PowerShell 7', names: ['pwsh.exe'], args: ['-NoLogo'] },
  { id: 'cmd', label: 'CMD', names: ['cmd.exe'], args: [] },
  { id: 'wsl', label: 'WSL', names: ['wsl.exe'], args: [] },
  { id: 'git-bash', label: 'Git Bash', names: [], args: ['--login', '-i'] },
];

let cached = null;
let cachedAt = 0;

function which(name) {
  if (process.platform !== 'win32') return '';
  try {
    const result = spawnSync('where.exe', [name], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    });
    if (result.status !== 0) return '';
    return String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

function gitBashPath() {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function discoverShells() {
  return SHELL_DEFS.map((def) => {
    let file = '';
    if (def.id === 'git-bash') file = gitBashPath();
    else if (def.id === 'cmd') file = process.env.ComSpec || which('cmd.exe');
    else file = def.names.map(which).find(Boolean) || '';
    return {
      id: def.id,
      label: def.label,
      args: def.args.slice(),
      file,
      available: !!file && fs.existsSync(file),
    };
  });
}

function listShells() {
  const now = Date.now();
  if (!cached || now - cachedAt > 15000) {
    cached = discoverShells();
    cachedAt = now;
  }
  return cached.map(s => ({ ...s, args: s.args.slice() }));
}

function resolveShell(id) {
  const wanted = String(id || 'powershell');
  const found = listShells().find(s => s.id === wanted && s.available && s.file);
  if (!found) return null;
  return { id: found.id, label: found.label, file: found.file, args: found.args.slice() };
}

function resolveCwd(input) {
  const fallback = process.env.USERPROFILE || process.cwd();
  const raw = String(input || '').trim();
  if (!raw) return fallback;
  const resolved = path.resolve(raw);
  let stat;
  try { stat = fs.statSync(resolved); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) {
    throw new Error(`工作目录不存在: ${resolved}`);
  }
  return resolved;
}

function clearShellCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = {
  listShells, resolveShell, resolveCwd, clearShellCache, SHELL_DEFS,
};
