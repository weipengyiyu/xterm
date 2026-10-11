'use strict';
const { contextBridge, ipcRenderer } = require('electron');
async function call(op, args) {
  const result = await ipcRenderer.invoke('xterm-download-files', op, args);
  if (result.error) throw new Error(result.error);
  return result.value;
}
function handle(entry) {
  if (!entry) return null;
  const base = { name: entry.name, kind: entry.kind,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted' };
  if (entry.kind === 'directory') {
    const child = async (kind, name, options = {}) => handle(await call('entry', {
      id: entry.id, name, kind, create: !!options.create,
    }));
    return { ...base, getDirectoryHandle: (name, options) => child('directory', name, options),
      getFileHandle: (name, options) => child('file', name, options) };
  }
  return { ...base, createWritable: async () => {
    const id = await call('open', { id: entry.id });
    return { write: bytes => call('write', { id, bytes }),
      seek: position => call('seek', { id, position }),
      close: () => call('close', { id }), abort: () => call('abort', { id }) };
  } };
}
contextBridge.exposeInMainWorld('xtermDesktopFiles', {
  pickDirectory: async () => handle(await call('pick')),
});
