'use strict';

// Build on the target OS/architecture: native bindings must match bundled Node.
const fs = require('fs');
const path = require('path');
const { check } = require('./dependencies');
const { stageRuntime } = require('./package-runtime');
const root = path.resolve(__dirname, '..');

async function main() {
  const failure = check(root, true);
  if (failure) throw new Error(`Cannot package an incomplete runtime: ${failure}`);
  const out = path.join(root, 'dist');
  fs.mkdirSync(out, { recursive: true });
  // Unique staging paths prevent overwriting an existing release or a running app.
  const name = `xterm-${process.platform}-${process.arch}-portable`;
  const stage = fs.mkdtempSync(path.join(out, `${name}-`));
  const pkgRoot = path.join(stage, name);
  fs.mkdirSync(pkgRoot);
  const { rustDeskBundled } = stageRuntime(pkgRoot);
  for (const file of ['package-lock.json', 'README.md', 'launch.ps1', 'launcher.vbs', 'run.bat', '启动.cmd', 'run.sh', 'stop.vbs', 'xterm-icon.ico']) {
    fs.copyFileSync(path.join(root, file), path.join(pkgRoot, file));
  }
  if (process.platform !== 'win32') fs.chmodSync(path.join(pkgRoot, 'run.sh'), 0o755);
  fs.writeFileSync(path.join(pkgRoot, 'START-HERE.txt'),
    `xterm portable (${process.platform}/${process.arch})\r\n\r\n` +
    `Extract the entire folder before running. Windows: double-click launcher.vbs.\r\n` +
    `No Node.js installation, administrator permission, or network download is required.\r\n` +
    `Keep runtime, node_modules, desktop, server, web and tools together.\r\n` +
    (rustDeskBundled ? `RustDesk Windows x64 portable client and its source/license materials are included in tools/rustdesk.\r\n` : '') +
    `Windows x64 requires Windows 10 1809 or later / Windows 11.\r\n` +
    `Other OS/architectures need a separate package built on that target.\r\n`);
  const { ZipArchive } = await import('archiver');
  const zipPath = path.join(out, `${name}-${Date.now()}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(pkgRoot, name);
    archive.finalize().catch(reject);
  });
  // Keep the unpacked artifact for offline and relocation verification.
  console.log(JSON.stringify({ directory: pkgRoot, archive: zipPath }));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
