const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
require(path.join(root, 'scripts', 'sync-web-app')).syncWebApp();
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const mod = fs.readFileSync(path.join(root, 'web', 'js', 'hotkeys.js'), 'utf8');

assert(html.includes('/js/hotkeys.js'), 'index.html must load hotkeys module');
assert(html.includes('id="hotkey-editor"'), 'settings must include hotkey editor');
assert(app.includes('xterm.hotkeys'), 'bundle must reference hotkeys localStorage key');
assert(app.includes('function loadHotkeys'), 'loadHotkeys missing');
assert(app.includes('function getHotkeyAction'), 'getHotkeyAction missing');
assert(app.includes('function fillHotkeyEditor'), 'fillHotkeyEditor missing');
assert(app.includes("getHotkeyAction(e"), 'keydown routing must consult getHotkeyAction');

const sandbox = {
  window: {},
  localStorage: { _data: {}, getItem(k){return this._data[k]||null;}, setItem(k,v){this._data[k]=String(v);} },
  document: { getElementById(){ return null; } },
};
sandbox.window.Xterm = {};
vm.runInNewContext(mod + '\nthis.loadHotkeys=loadHotkeys; this.eventMatchesHotkey=eventMatchesHotkey; this.formatHotkey=formatHotkey; this.DEFAULT_HOTKEYS=DEFAULT_HOTKEYS; this.saveHotkeys=saveHotkeys;', sandbox);
const map = sandbox.loadHotkeys();
assert(map.newConnection && map.terminalSearch && map.manualReconnect && map.openSettings);
assert(map.fontIncrease && map.fontDecrease);
assert.strictEqual(sandbox.formatHotkey(map.newConnection), 'Ctrl+N');
assert(sandbox.eventMatchesHotkey({ ctrlKey:true, metaKey:false, shiftKey:false, altKey:false, key:'n' }, map.newConnection));
sandbox.saveHotkeys(Object.assign({}, map, { newConnection: { ctrl:true, shift:true, alt:false, key:'n' } }));
const next = sandbox.loadHotkeys();
assert.strictEqual(next.newConnection.shift, true);
vm.runInNewContext(mod + '\nthis.getHotkeyAction=getHotkeyAction;', sandbox);
assert.strictEqual(sandbox.getHotkeyAction({ key: ' ', ctrlKey: false }, { newConnection: { key: ' ' } }), null,
  'a saved plain-space shortcut must not steal terminal input');
assert.strictEqual(sandbox.getHotkeyAction({ key: 'n', ctrlKey: true, isComposing: true }, map), null,
  'IME composition must not trigger shortcuts');

console.log('✅ hotkeys contract passed');
