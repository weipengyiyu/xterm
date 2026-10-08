const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'web', 'app.main.js'), 'utf8');
const split = fs.readFileSync(path.join(root, 'web', 'js', 'split-panes.js'), 'utf8');
const clip = fs.readFileSync(path.join(root, 'web', 'js', 'clipboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

assert(main.includes('term.onTitleChange'), 'OSC 0/2 must update the tab title');
assert(main.includes('function tabLabel'), 'tab label must prefer the OSC title');
assert(main.includes('function noteTabActivity'), 'background output must mark the tab');
assert(main.includes("activity === 'done'"), 'quiet background tabs must show completion');
assert(main.includes('paneCfgs:'), 'merged panes must remember their own session');
assert(split.includes('function mergeTabInto'), 'dragging a tab must be able to join a split');
assert(split.includes('function togglePaneMaximize'), 'the focused pane must be able to fill the tab');
assert(split.includes('split-drop-overlay'), 'the terminal must show drop zones while dragging');
assert(html.includes('id="btn-pane-max"'), 'maximize control is in the toolbar');
assert(clip.includes('term._lastCtrlCSel !== sel'), 'the first Ctrl+C copies and the next one interrupts');
assert(clip.includes('pasteClipboard(term)'), 'right-click pastes');
assert(!clip.includes('term.clearSelection();\n    } else {\n      pasteClipboard'), 'right-click no longer copies the selection');

console.log('✅ tab feel contract passed');
