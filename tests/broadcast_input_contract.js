const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../web/app.main.js'), 'utf8');

assert(html.includes('id="btn-broadcast"'), 'toolbar must expose broadcast input');
assert(main.includes('function broadcastInputToOthers'), 'broadcast fan-out must be implemented');
assert(main.includes("localStorage.getItem('xterm.broadcast')"), 'broadcast mode must persist');
assert(/if \(!safeSendInput\(connId, payload/.test(main), 'a cancelled multiline paste must not fan out');
assert(main.includes('target.state !== \'connected\''), 'broadcast must skip disconnected terminals');
assert(main.includes("tab.cfg?.type === 'vnc'"), 'broadcast must skip VNC sessions');

console.log('✅ broadcast input contract passed');
