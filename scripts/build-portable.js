'use strict';

// Build on the target OS/architecture: native bindings must match bundled Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check } = require('./dependencies');
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
  for (const dir of ['server', 'web', 'desktop', 'scripts']) {
    fs.cpSync(path.join(root, dir), path.join(pkgRoot, dir), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'launch.ps1', 'launcher.vbs', 'run.bat', 'run.sh', 'stop.vbs', 'xterm-icon.ico']) {
    fs.copyFileSync(path.join(root, file), path.join(pkgRoot, file));
  }
  // Include the installed production dependency graph, excluding build-only
  // caxa and puppeteer. Read each installed package's dependencies to include
  // hoisted transitive modules and preserve nested module resolution.
  const copied = new Set();
  function copyPackage(name, fromDir) {
    let current = fromDir;
    let source;
    while (current.startsWith(root)) {
      const candidate = path.join(current, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) { source = candidate; break; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!source) throw new Error(`Missing packaged dependency: ${name}`);
    if (copied.has(source)) return;
    copied.add(source);
    const relative = path.relative(root, source);
    const target = path.join(pkgRoot, relative);
    fs.cpSync(source, target, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies || {})) copyPackage(dependency, source);
    for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
      try { copyPackage(dependency, source); } catch {}
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  delete manifest.dependencies['puppeteer-core'];
  delete manifest.devDependencies;
  for (const dependency of Object.keys(manifest.dependencies)) copyPackage(dependency, root);
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify(manifest, null, 2));
  fs.mkdirSync(path.join(pkgRoot, 'runtime'));
  fs.copyFileSync(process.execPath, path.join(pkgRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
  for (const file of ['run.sh', 'runtime/node']) {
    if (process.platform !== 'win32') fs.chmodSync(path.join(pkgRoot, file), 0o755);
  }
  fs.writeFileSync(path.join(pkgRoot, 'portable.json'), JSON.stringify({
    platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
    nodeVersion: process.version, version: manifest.version,
  }, null, 2));
  fs.writeFileSync(path.join(pkgRoot, 'START-HERE.txt'),
    `xterm portable (${process.platform}/${process.arch})\r\n\r\n` +
    `Extract the entire folder before running. Windows: double-click launcher.vbs.\r\n` +
    `No Node.js installation, administrator permission, or network download is required.\r\n` +
    `Keep runtime, node_modules, desktop, server and web together.\r\n` +
    `Windows x64 requires Windows 10 1809 or later / Windows 11.\r\n` +
    `Other OS/architectures need a separate package built on that target.\r\n`);
  const packedFailure = check(pkgRoot, true);
  if (packedFailure) throw new Error(`Packaged runtime verification failed: ${packedFailure}`);
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
