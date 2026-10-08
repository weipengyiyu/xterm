// Token / origin / CSP helpers for the loopback HTTP+WS service.
'use strict';

const path = require('path');

function buildStaticCsp(port) {
  return [
    "default-src 'self'",
    "connect-src 'self' ws://127.0.0.1:" + port + " ws://localhost:" + port + " ws://[::1]:" + port,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self' 'wasm-unsafe-eval'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function createSecurity({ port, clientToken }) {
  function hasClientToken(req) {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      return u.searchParams.get('token') === clientToken;
    } catch { return false; }
  }

  function hasCliCapability(req) {
    return req.headers['x-sshterm-token'] === clientToken;
  }

  function isTrustedOrigin(req) {
    const source = req.headers.origin || req.headers.referer;
    if (!source) return false;
    try {
      const u = new URL(source);
      const validHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
        || u.hostname === '[::1]' || u.hostname === '::1';
      const origPort = u.port || (u.protocol === 'https:' ? '443' : '80');
      return validHost && origPort === String(port);
    } catch { return false; }
  }

  function isLoopbackSocket(req) {
    const ra = (req.socket && req.socket.remoteAddress) || '';
    return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  }

  function isLoopbackHost(req) {
    const host = String(req.headers.host || '');
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  }

  function isTrustedRequest(req) {
    if (isTrustedOrigin(req) || hasCliCapability(req)) return true;
    // Server listens on loopback only. Some browsers / privacy modes omit
    // Origin+Referer on same-machine script/fetch; still allow those so the
    // UI can obtain the WS token. Cross-site pages still send Origin/Referer
    // and remain rejected by isTrustedOrigin.
    if (!req.headers.origin && !req.headers.referer && isLoopbackSocket(req) && isLoopbackHost(req)) {
      return true;
    }
    return false;
  }

  function isInside(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
  }

  return {
    STATIC_CSP: buildStaticCsp(port),
    hasClientToken,
    hasCliCapability,
    isTrustedOrigin,
    isTrustedRequest,
    isInside,
  };
}

module.exports = { createSecurity, buildStaticCsp };
