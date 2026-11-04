'use strict';

const fs = require('fs');
const path = require('path');
const { check } = require('./dependencies');
const { copyBundledRustDesk } = require('./bundled-rustdesk');
const root = path.resolve(__dirname, '..');

// Stage an offline runtime with native bindings for the build host.
function stageRuntime(pkgRoot) {
  for (const dir of ['server', 'web', 'desktop', 'scripts']) {
    fs.cpSync(path.join(root, dir), path.join(pkgRoot, dir), { recursive: true });
  }
  const rustDeskBundled = copyBundledRustDesk(pkgRoot);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(pkgRoot, 'LICENSE'));
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
  if (process.platform !== 'win32') fs.chmodSync(path.join(pkgRoot, 'runtime', 'node'), 0o755);
  fs.writeFileSync(path.join(pkgRoot, 'portable.json'), JSON.stringify({
    platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
    nodeVersion: process.version, version: manifest.version,
    rustDeskBundled,
  }, null, 2));
  const packedFailure = check(pkgRoot, true);
  if (packedFailure) throw new Error(`Packaged runtime verification failed: ${packedFailure}`);
  return { rustDeskBundled };
}

module.exports = { stageRuntime };
