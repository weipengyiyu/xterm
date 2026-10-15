'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const bundle = path.resolve(__dirname, '..', 'tools', 'rustdesk');

function verifyRustDeskBundle(directory = bundle) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const required of ['rustdesk.exe', 'LICENSE', 'NOTICE.md', ...Object.values(manifest.sourceArchives || {})]) {
    if (!manifest.files?.[required]) throw new Error(`Missing RustDesk bundle metadata: ${required}`);
  }
  if (Object.keys(manifest.sourceArchives || {}).length !== 2) throw new Error('Missing RustDesk source archives');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const target = path.resolve(directory, name);
    const relative = path.relative(directory, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid RustDesk bundle file path');
    const bytes = fs.readFileSync(target);
    if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new Error(`RustDesk bundle checksum mismatch: ${name}`);
    }
  }
  return manifest;
}

function copyBundledRustDesk(targetRoot, { platform = process.platform, arch = process.arch } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  if (manifest.platform !== platform || manifest.arch !== arch) return false;
  verifyRustDeskBundle();
  fs.cpSync(bundle, path.join(targetRoot, 'tools', 'rustdesk'), { recursive: true });
  return true;
}

module.exports = { verifyRustDeskBundle, copyBundledRustDesk };
