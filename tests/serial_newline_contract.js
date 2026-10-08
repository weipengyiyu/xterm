const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sanitizeSession } = require('../server/session-schema');

const src = fs.readFileSync(path.join(__dirname, '../web/js/clipboard.js'), 'utf8');
const start = src.indexOf('function applySerialNewline');
const end = src.indexOf('function safeSendInput');
assert(start >= 0 && end > start, 'applySerialNewline must live next to the input path');
const applySerialNewline = vm.runInNewContext(
  `${src.slice(start, end)}\napplySerialNewline`,
  Object.create(null),
);

const serial = { type: 'serial', newline: 'crlf' };
assert.strictEqual(applySerialNewline(serial, 'hi\r'), 'hi\r\n');
assert.strictEqual(applySerialNewline(serial, 'a\r\nb\n'), 'a\r\nb\r\n');
assert.strictEqual(applySerialNewline({ type: 'serial', newline: 'lf' }, 'hi\r'), 'hi\n');
assert.strictEqual(applySerialNewline({ type: 'serial' }, 'hi\r'), 'hi\r');
assert.strictEqual(applySerialNewline({ type: 'serial', hexMode: true, newline: 'crlf' }, 'AA\r'), 'AA\r');
assert.strictEqual(applySerialNewline({ type: 'ssh', newline: 'crlf' }, 'hi\r'), 'hi\r');
assert.strictEqual(applySerialNewline(serial, 'plain'), 'plain');

const saved = sanitizeSession({
  name: 'board', type: 'serial', port: 'COM3', newline: 'lf', hexMode: false,
});
assert.strictEqual(saved.newline, 'lf');
const rejected = sanitizeSession({
  name: 'board', type: 'serial', port: 'COM3', newline: 'evil',
});
assert.strictEqual(rejected.newline, 'cr');

console.log('✅ serial newline contract passed');
