'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function validRequest(value) {
  if (!value || value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.id || '')) return null;
  if (typeof value.path !== 'string' || !path.isAbsolute(value.path)) return null;
  if (path.basename(value.path) !== 'ready.json' || !path.basename(path.dirname(value.path)).startsWith('xterm-startup-')) return null;
  return { version: 1, id: value.id, path: value.path };
}

function createRequest(directory) {
  return { version: 1, id: crypto.randomBytes(16).toString('hex'), path: path.join(directory, 'ready.json') };
}

function readRequest(environment = process.env) {
  try { return validRequest(JSON.parse(environment.XTERM_STARTUP_REQUEST || 'null')); } catch { return null; }
}

function writeResponse(request, result) {
  if (!validRequest(request)) throw new Error('Invalid startup response destination');
  const temporary = `${request.path}.${request.id}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...result, version: 1, requestId: request.id }));
  fs.renameSync(temporary, request.path);
}

function readResponse(request) {
  let result;
  try { result = JSON.parse(fs.readFileSync(request.path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (result.version !== 1 || result.requestId !== request.id) throw new Error('Startup response did not match this launch');
  if (typeof result.ok !== 'boolean') throw new Error('Invalid startup response');
  return result;
}

module.exports = { validRequest, createRequest, readRequest, writeResponse, readResponse };
