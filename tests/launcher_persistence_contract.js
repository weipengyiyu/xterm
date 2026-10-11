'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'scripts', 'launch.js'), 'utf8');
const powershell = fs.readFileSync(path.join(root, 'launch.ps1'), 'utf8');
const batch = fs.readFileSync(path.join(root, 'run.bat'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'run.sh'), 'utf8');
const stopper = fs.readFileSync(path.join(root, 'stop.vbs'), 'utf8');
const vbs = fs.readFileSync(path.join(root, 'launcher.vbs'), 'utf8');
const entry = fs.readFileSync(path.join(root, '启动.cmd'), 'utf8');

assert.match(launcher, /preserving active sessions/,
  'a second launch must preserve the running server and its SSH sessions');
assert.match(launcher, /detached: true/,
  'the Node service must outlive the launcher');
assert.match(launcher, /--no-open/,
  'the background service must not open a second browser');
assert.match(launcher, /stdio: \['ignore', stdout, stderr\]/,
  'detached output must go directly to files, not pipes owned by the launcher');
assert.doesNotMatch(launcher.slice(launcher.indexOf('// Use file descriptors')), /child\.kill\(/,
  'background launch must never replace a live server');
assert.match(launcher, /path\.resolve\(__dirname, '\.\.'\)/,
  'project paths must be resolved from the script location');
assert.match(powershell, /\$PSScriptRoot/);
assert.match(batch, /%~dp0launch\.ps1/);
assert.match(batch, /%\*/,'batch must forward startup arguments');
assert.match(shell, /dirname -- "\$0"/);
assert.match(shell, /"\$@"/,'shell must preserve argument boundaries');
assert.match(vbs, /GetParentFolderName\(WScript\.ScriptFullName\)/);
assert.match(vbs, /launch\.ps1/);
assert.match(vbs, /-WindowStyle Hidden/);
assert.match(vbs, /ws\.Run\(cmd, 0, True\)/, 'double-click startup must keep its PowerShell window hidden');
assert.match(entry, /start "" "%SystemRoot%\\System32\\wscript\.exe" "%~dp0launcher\.vbs" %\*/,
  'CMD entry must hand off to the hidden launcher and exit immediately');
for (const script of [launcher, powershell, batch, shell, vbs]) {
  assert.doesNotMatch(script, /[A-Z]:\\(?:xterm|xterm|tools)\b/i,
    'launchers must not bind an installation directory');
  assert.doesNotMatch(script, /mklink|New-Item.*(?:HardLink|Junction|SymbolicLink)/i,
    'launchers must not create directory links');
}

assert.match(stopper, /http:\/\/127\.0\.0\.1:8787\/launcher-info/);
assert.match(stopper, /""app""\\s\*:\\s\*""xterm""/);
assert.match(stopper, /Win32_Process WHERE ProcessId = /);
assert.doesNotMatch(stopper, /taskkill|\/IM\s+node\.exe|Name\s*=\s*['"]node\.exe/i);
console.log('✅ launcher portability/session-persistence contract passed');
