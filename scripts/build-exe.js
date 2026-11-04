'use strict';

const fs = require('fs');
const path = require('path');
const { check } = require('./dependencies');
const { stageRuntime } = require('./package-runtime');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
const target = path.join(out, 'xterm.exe');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Build xterm.exe with Windows x64 Node.js.');
  }
  const failure = check(root, true);
  if (failure) throw new Error('Cannot package an incomplete runtime: ' + failure);
  const { default: caxa } = await import('caxa');
  fs.mkdirSync(out, { recursive: true });
  const staging = fs.mkdtempSync(path.join(out, '.xterm-exe-'));
  try {
    const runtime = path.join(staging, 'runtime-files');
    fs.mkdirSync(runtime);
    stageRuntime(runtime);
    const executable = path.join(staging, 'xterm.exe');
    await caxa({
      input: runtime,
      output: executable,
      dedupe: false,
      includeNode: false,
      uncompressionMessage: 'Preparing xterm for first launch',
      command: ['{{caxa}}/runtime/node.exe', '{{caxa}}/scripts/launch-exe.js'],
    });
    fs.renameSync(executable, target);
    console.log('Built ' + target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
