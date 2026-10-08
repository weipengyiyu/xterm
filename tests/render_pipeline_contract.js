const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'web', 'app.main.js'), 'utf8');
const split = fs.readFileSync(path.join(root, 'web', 'js', 'split-panes.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const handlers = fs.readFileSync(path.join(root, 'server', 'ws-handlers.js'), 'utf8');

assert(html.includes('/vendor/@xterm/addon-webgl/lib/addon-webgl.js'), 'webgl addon script');
assert(html.includes('/vendor/@xterm/addon-canvas/lib/addon-canvas.js'), 'canvas addon script');
assert(fs.existsSync(path.join(root, 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js')));
assert(fs.existsSync(path.join(root, 'node_modules', '@xterm', 'addon-canvas', 'lib', 'addon-canvas.js')));

assert(main.includes('function attachGpuRenderer'), 'gpu renderer helper');
assert(main.includes('attachCanvasRenderer(term)'), 'canvas fallback');
assert(main.includes("addon.onContextLoss"), 'webgl context-loss fallback');
assert(main.includes('requestAnimationFrame'), 'frame batching');
assert(main.includes('target.term.write(text, done)'), 'single write with callback');
assert(main.includes("type: hold ? 'output-hold' : 'output-release'"), 'client flow control');
assert(main.includes('function isDrawTarget'), 'visible-target draw gate');
assert(main.includes('pane-max-hidden'), 'maximized panes stay buffered');
assert(main.includes('DRAW_FRAME_CHARS'), 'a frame must not parse an unbounded write');
assert(main.includes('drawBusy'), 'only one terminal parse runs at a time');
assert(main.includes('function queueReplay'), 'replay off the write path');
const outputStart = main.indexOf('function processTerminalOutput');
const outputEnd = main.indexOf('\nfunction send', outputStart);
const outputBody = main.slice(outputStart, outputEnd);
assert(!outputBody.includes('recParts'), 'recParts must stay off the per-packet path');
assert(outputBody.includes('queueReplay(target, text)'), 'packets queue replay text');
assert(outputBody.includes('scheduleTerminalDraw(target)'), 'visible packets schedule one draw');

const openAt = main.indexOf('term.open(host);');
const gpuAt = main.indexOf('attachGpuRenderer(term);');
assert(openAt > 0 && gpuAt > openAt, 'newTab loads the renderer after term.open');
const splitOpen = split.indexOf('term.open(host);');
const splitGpu = split.indexOf('attachGpuRenderer(term);');
assert(splitOpen > 0 && splitGpu > splitOpen, 'split pane loads the renderer after term.open');
assert(split.includes('_ownerTab: tab'), 'split panes keep their owner tab');

assert(server.includes('function holdOutputs'), 'server hold');
assert(server.includes('function releaseOutputs'), 'server release');
assert(server.includes('ownerWs._clientHold'), 'hold pauses producers');
assert(handlers.includes("case 'output-hold'"), 'hold message');
assert(handlers.includes("case 'output-release'"), 'release message');

console.log('✅ render pipeline contract passed');
