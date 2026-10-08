const assert = require('assert');
const os = require('os');
const { listShells, resolveShell, resolveCwd, clearShellCache } = require('../server/local-shells');
const { sanitizeSession } = require('../server/session-schema');
const { connectionTargetsMatch } = require('../server/connection-config');
const LocalConnection = require('../server/connections/local');

clearShellCache();
const shells = listShells();
const cmd = shells.find(s => s.id === 'cmd');
assert(cmd && cmd.available, 'CMD must be discoverable on Windows');
assert(shells.some(s => s.id === 'powershell'), 'PowerShell profile must be listed');
assert.strictEqual(resolveShell('not-a-shell'), null, 'unknown shell ids must not resolve to an executable');
assert.strictEqual(resolveShell('..\\..\\Windows\\System32\\cmd.exe'), null);
assert.strictEqual(resolveCwd(''), process.env.USERPROFILE || process.cwd());
assert.strictEqual(resolveCwd(os.tmpdir()), require('path').resolve(os.tmpdir()));
assert.throws(() => resolveCwd('D:\\sshterm-missing-cwd-dir'), /工作目录不存在/);

const saved = sanitizeSession({
  name: 'PowerShell', type: 'local', shell: 'pwsh', cwd: 'C:\\work',
  password: 'nope', host: 'evil', port: 22,
});
assert.strictEqual(saved.shell, 'pwsh');
assert.strictEqual(saved.cwd, 'C:\\work');
assert.strictEqual(saved.password, undefined);
assert.strictEqual(saved.host, undefined);
assert.strictEqual(saved.rememberPassword, false);
assert.strictEqual(sanitizeSession({ name: 'x', type: 'local', shell: 'C:\\evil.exe' }).shell, 'powershell');

assert.strictEqual(
  connectionTargetsMatch(
    { type: 'local', shell: 'cmd', cwd: 'C:\\work' },
    { type: 'local', shell: 'powershell', cwd: 'C:\\work' },
  ),
  false,
);
assert.strictEqual(
  connectionTargetsMatch(
    { type: 'local', shell: 'cmd', cwd: '' },
    { type: 'local' },
  ),
  false,
);

(async () => {
  const conn = new LocalConnection({ type: 'local', shell: 'cmd', cwd: os.tmpdir() });
  let text = '';
  conn.on('data', (buf) => { text += buf.toString('utf8'); });
  await conn.connect();
  conn.write('echo SSHTERM_LOCAL_OK\r\n');
  const deadline = Date.now() + 8000;
  while (!text.includes('SSHTERM_LOCAL_OK') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  conn.close();
  assert(text.includes('SSHTERM_LOCAL_OK'), `local shell did not echo marker, got: ${text.slice(-300)}`);
  console.log('✅ local shell contract passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
