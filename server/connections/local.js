// 本机终端: Windows ConPTY (node-pty). 只启动服务端识别出的 Shell，不接受任意可执行文件。
const BaseConnection = require('./base');
const { resolveShell, resolveCwd } = require('../local-shells');

class LocalConnection extends BaseConnection {
  async connect() {
    this.state = 'connecting';
    let pty;
    try {
      pty = require('node-pty');
    } catch (e) {
      this.state = 'closed';
      const err = new Error('本机终端组件未安装 (node-pty / ConPTY)');
      this._emitError(err.message);
      throw err;
    }
    const spec = resolveShell(this.config.shell || 'powershell');
    if (!spec) {
      this.state = 'closed';
      const err = new Error(`本机没有可用的 Shell: ${this.config.shell || 'powershell'}`);
      this._emitError(err.message);
      throw err;
    }
    let cwd;
    try {
      cwd = resolveCwd(this.config.cwd);
    } catch (e) {
      this.state = 'closed';
      this._emitError(e.message);
      throw e;
    }
    const cols = clampDim(this.config.cols, 120);
    const rows = clampDim(this.config.rows, 32);
    try {
      this.pty = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        useConpty: process.platform === 'win32',
      });
    } catch (e) {
      this.state = 'closed';
      const err = new Error(`本机终端启动失败: ${e.message}`);
      this._emitError(err.message);
      throw err;
    }
    this.pty.onData((data) => {
      if (this.state === 'closing' || this.state === 'closed') return;
      this._emitData(Buffer.from(data, 'utf8'));
    });
    this.pty.onExit(({ exitCode } = {}) => {
      this._emitClose(`本机终端已退出 (${exitCode ?? 0})`);
    });
    this.state = 'connected';
    this.emit('open');
  }

  write(data) {
    if (!this.pty || this.state !== 'connected') return false;
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    try { this.pty.write(text); } catch { return false; }
    return true;
  }

  resize(cols, rows) {
    if (!this.pty || this.state !== 'connected') return;
    try { this.pty.resize(clampDim(cols, 80), clampDim(rows, 24)); } catch {}
  }

  close() {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    try { this.pty && this.pty.kill(); } catch {}
    this._emitClose('已断开');
  }
}

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, 500);
}

module.exports = LocalConnection;
