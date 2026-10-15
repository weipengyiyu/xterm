'use strict';

function installRustDeskPicker(win, { ipcMain, dialog }, allowedOrigin) {
  let picker = null;
  ipcMain.handle('xterm-rustdesk-pick', async event => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
        || new URL(event.senderFrame.url).origin !== allowedOrigin()) {
      throw new Error('不允许选择 RustDesk 客户端');
    }
    if (!picker) picker = dialog.showOpenDialog(win, {
      title: '选择 RustDesk 客户端', properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'RustDesk', extensions: ['exe'] }] : [],
    }).then(result => result.canceled ? null : result.filePaths[0] || null)
      .finally(() => { picker = null; });
    return picker;
  });
  win.on('closed', () => ipcMain.removeHandler('xterm-rustdesk-pick'));
}

module.exports = { installRustDeskPicker };
