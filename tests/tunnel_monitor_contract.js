const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ssh = fs.readFileSync(path.join(__dirname, '..', 'server', 'connections', 'ssh.js'), 'utf8');
const root = path.join(__dirname, '..');

function readServerSources() {
  const dir = path.join(root, 'server');
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.bak') && name !== 'free-serial.ps1')
    .sort();
  const nested = [];
  const connDir = path.join(dir, 'connections');
  if (fs.existsSync(connDir)) {
    for (const name of fs.readdirSync(connDir).filter((n) => n.endsWith('.js')).sort()) {
      nested.push(path.join('connections', name));
    }
  }
  return [...files, ...nested].map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8')).join('\n');
}

const server = readServerSources();
const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
for (const field of ['state', 'createdAt', 'rxBytes', 'txBytes', 'connections', 'lastError']) assert(ssh.includes(field), `tunnel metric missing: ${field}`);
assert(ssh.includes('_pipeTunnel'), 'tunnel byte accounting missing');
assert(server.includes('saved.tunnels'), 'tunnel persistence missing');
assert(server.includes('隧道恢复失败'), 'tunnel recovery alert missing');
assert(ui.includes('tunnelRefreshTimer') && ui.includes('formatBytes(t.rxBytes)'), 'tunnel monitoring UI missing');
assert(ui.includes('collectTunnelForm') && ui.includes('TUNNEL_TYPE_HELP'), 'tunnel form helpers missing');
assert(ui.includes('data-tn-type="local"') || fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8').includes('data-tn-type="local"'),
  'tunnel type tabs missing in HTML');
assert(server.includes('Replace with live list') || server.includes('conn.listTunnels().map'),
  'tunnel persistence must replace the live list, not append');
console.log('✅ tunnel monitoring contract passed');
