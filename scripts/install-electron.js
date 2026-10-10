'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function electronSources(configured, zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (configured) return [configured];
  const official = 'https://github.com/electron/electron/releases/download/';
  const mirror = 'https://npmmirror.com/mirrors/electron/';
  return /Shanghai|Chongqing|Urumqi|Hong_Kong|Macao/.test(zone) ? [mirror, official] : [official, mirror];
}
async function installElectron(root, log = console.log) {
  const load = require('module').createRequire(path.join(root, 'node_modules', 'electron', 'package.json'));
  const { version } = load('./package.json');
  const checksums = load('./checksums.json');
  const { downloadArtifact } = load('@electron/get');
  const extract = load('extract-zip');
  const directory = path.join(root, 'node_modules', 'electron');
  const executable = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  const target = path.join(directory, 'dist');
  if (fs.existsSync(path.join(target, executable)) && fs.existsSync(path.join(target, 'version')) &&
      fs.readFileSync(path.join(target, 'version'), 'utf8').trim().replace(/^v/, '') === version) {
    fs.writeFileSync(path.join(directory, 'path.txt'), executable); return;
  }
  let lastError;
  for (const source of electronSources(process.env.ELECTRON_MIRROR || process.env.npm_config_electron_mirror)) {
    try {
      log(`Preparing application window: Electron ${version} from ${new URL(source).hostname}`);
      let lastProgress = 0;
      const archive = await downloadArtifact({
        version, artifactName: 'electron', platform: process.platform, arch: process.arch, checksums,
        cacheRoot: process.env.electron_config_cache || path.join(os.homedir(), '.xterm', 'cache', 'electron'),
        mirrorOptions: { mirror: source },
        downloadOptions: {
          timeout: { connect: 8000, response: 15000, socket: 30000, request: 180000 }, retry: { limit: 0 }, quiet: true,
          getProgressCallback: progress => {
            if (!progress.total || progress.total < 1024 * 1024) return;
            if (Date.now() - lastProgress > 5000 || progress.percent === 1) {
              lastProgress = Date.now(); log(`Downloading application window: ${Math.round(progress.percent * 100)}%`);
            }
          },
        },
      });
      await extract(archive, { dir: target });
      if (!fs.existsSync(path.join(target, executable))) throw new Error('Downloaded archive has no Electron executable');
      fs.writeFileSync(path.join(directory, 'path.txt'), executable);
      log('Application window components are ready.'); return;
    } catch (error) { lastError = error; log(`Window download failed: ${error.code || error.message}. Trying the next source.`); }
  }
  throw new Error(`Window download failed: ${lastError?.message}`);
}
module.exports = { installElectron, electronSources };
if (require.main === module) installElectron(process.argv[2] || path.resolve(__dirname, '..')).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
