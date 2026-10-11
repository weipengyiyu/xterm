'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

// Renderer receives opaque handles, never a general-purpose filesystem API.
// Every handle belongs to a directory selected through the native dialog.
function installDownloadFiles(win, { ipcMain, dialog }, allowedOrigin) {
  const handles = new Map();
  const writers = new Map();
  let picker = null;
  const remember = (entry) => {
    const id = randomUUID();
    handles.set(id, entry);
    return { id, name: path.basename(entry.path), kind: entry.kind };
  };
  const get = async (id) => {
    const entry = handles.get(id);
    if (!entry) throw new Error('本地目录已失效，请重新选择');
    // Resolve the parent each time: a replaced directory/junction must not
    // redirect writes outside the user's chosen root.
    const parent = await fs.realpath(entry.kind === 'directory' ? entry.path : path.dirname(entry.path));
    const relative = path.relative(entry.root, parent);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('本地路径超出选定目录');
    }
    return entry;
  };
  const cleanup = async () => {
    handles.clear();
    const pending = [...writers.values()];
    writers.clear();
    await Promise.allSettled(pending.map(async w => {
      try { await w.file.close(); } catch {}
      await fs.rm(w.temp, { force: true });
    }));
  };
  ipcMain.handle('xterm-download-files', async (event, op, args = {}) => {
    try {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
          || new URL(event.senderFrame.url).origin !== allowedOrigin()) {
        throw new Error('不允许访问本地下载目录');
      }
      let value;
      if (op === 'pick') {
        if (!picker) picker = dialog.showOpenDialog(win, {
          title: '选择下载保存目录', properties: ['openDirectory', 'createDirectory'],
        }).then(async result => {
          if (result.canceled || !result.filePaths.length) return null;
          const root = await fs.realpath(result.filePaths[0]);
          return remember({ path: root, root, kind: 'directory' });
        }).finally(() => { picker = null; });
        value = await picker;
      } else if (op === 'entry') {
        const parent = await get(args.id);
        if (parent.kind !== 'directory' || typeof args.name !== 'string'
            || !args.name || args.name === '.' || args.name === '..'
            || !['file', 'directory'].includes(args.kind)
            || /[\\/:\x00-\x1f]/.test(args.name) || /[. ]$/.test(args.name)) {
          throw new Error('无效的本地文件名');
        }
        const target = path.join(parent.path, args.name);
        let st;
        try { st = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (st?.isSymbolicLink()) throw new Error('不能写入符号链接');
        if (st && st.isDirectory() !== (args.kind === 'directory')) throw new Error('TypeMismatch: 本地已有同名文件或目录');
        if (!st && !args.create) throw new Error('本地文件不存在');
        if (!st && args.kind === 'directory') await fs.mkdir(target);
        value = remember({ path: target, root: parent.root, kind: args.kind });
      } else if (op === 'open') {
        const entry = await get(args.id);
        if (entry.kind !== 'file') throw new Error('请选择文件');
        if ([...writers.values()].some(w => w.target === entry.path)) throw new Error('该文件正在下载');
        const temp = path.join(path.dirname(entry.path), `.xterm-${randomUUID()}.part`);
        const file = await fs.open(temp, 'wx');
        const id = randomUUID();
        writers.set(id, { file, temp, target: entry.path, handle: args.id, position: 0 });
        value = id;
      } else {
        const writer = writers.get(args.id);
        if (!writer) throw new Error('下载写入已结束');
        if (op === 'write') {
          const bytes = Buffer.from(args.bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await writer.file.write(bytes, offset, bytes.length - offset, writer.position);
            if (!bytesWritten) throw new Error('本地磁盘写入失败');
            offset += bytesWritten; writer.position += bytesWritten;
          }
        } else if (op === 'seek') {
          if (!Number.isSafeInteger(args.position) || args.position < 0) throw new Error('无效的续传位置');
          writer.position = args.position;
        } else if (op === 'close' || op === 'abort') {
          if (op === 'close') {
            await get(writer.handle);
            await writer.file.sync();
          }
          try { await writer.file.close(); } catch (error) { if (op !== 'abort') throw error; }
          if (op === 'close') await fs.rename(writer.temp, writer.target);
          else await fs.rm(writer.temp, { force: true });
          writers.delete(args.id);
        } else throw new Error('无效的下载操作');
      }
      return { value };
    } catch (error) { return { error: error.message }; }
  });
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) void cleanup();
  });
  win.on('closed', () => { ipcMain.removeHandler('xterm-download-files'); void cleanup(); });
}

module.exports = { installDownloadFiles };
