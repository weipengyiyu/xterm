'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyRustDeskBundle, copyBundledRustDesk } = require('../scripts/bundled-rustdesk');
const { resolveRustDesk } = require('../server/rustdesk-launcher');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-rustdesk-bundle-'));
  try {
    const manifest = verifyRustDeskBundle();
    assert.strictEqual(manifest.platform, 'win32');
    assert.strictEqual(manifest.arch, 'x64');
    assert.strictEqual(copyBundledRustDesk(root, { platform: 'linux', arch: 'x64' }), false);
    assert.strictEqual(copyBundledRustDesk(root, { platform: 'win32', arch: 'arm64' }), false);
    assert(!fs.existsSync(path.join(root, 'tools')), 'unsupported targets must not copy an incompatible client');
    assert.strictEqual(copyBundledRustDesk(root, { platform: 'win32', arch: 'x64' }), true);
    const directory = path.join(root, 'tools', 'rustdesk');
    assert.deepStrictEqual(verifyRustDeskBundle(directory), manifest);
    const other = path.join(root, 'installed');
    fs.mkdirSync(path.join(other, 'RustDesk'), { recursive: true });
    const installed = path.join(other, 'RustDesk', 'rustdesk.exe');
    fs.writeFileSync(installed, 'fixture');
    const options = { platform: 'win32', root, env: { ProgramFiles: other } };
    assert.strictEqual(await resolveRustDesk('', options), path.join(directory, 'rustdesk.exe'), 'default detection prefers bundled client');
    assert.strictEqual(await resolveRustDesk(installed, options), installed, 'explicit client overrides bundle');
    assert.strictEqual(await resolveRustDesk('', { ...options, env: { XTERM_RUSTDESK: installed } }), installed);
    fs.appendFileSync(path.join(directory, 'NOTICE.md'), '\ncorrupted fixture\n');
    assert.throws(() => verifyRustDeskBundle(directory), /checksum mismatch/);
    console.log('✅ RustDesk bundle checksums, distribution files, package copying, platform gating and client precedence passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
