'use strict';

// Keep native window/webContents focus in step with the renderer. A focused
// BrowserWindow alone does not guarantee that Chromium receives keyboard input.
function installTerminalWindowFocus(win) {
  const contents = win.webContents;
  const restore = () => {
    if (win.isDestroyed() || contents.isDestroyed() || win.isMinimized() || !win.isFocused()) return;
    if (!contents.isFocused()) contents.focus();
    if (!contents.isLoadingMainFrame()) contents.send('xterm-terminal-focus');
  };
  const beforeInput = (event, input) => {
    if (input.type !== 'keyDown') return;
    // There is no application menu, so Electron has no default reload shortcut.
    const key = String(input.key || '').toLowerCase();
    if (input.control && !input.alt && !input.meta && (key === 'f5' || (input.shift && key === 'r'))) {
      event.preventDefault();
      contents.reloadIgnoringCache();
      return;
    }
    if (!contents.isFocused()) restore();
  };
  win.on('focus', restore);
  win.on('restore', restore);
  contents.on('did-finish-load', restore);
  contents.on('before-input-event', beforeInput);
  win.once('closed', () => {
    win.removeListener('focus', restore);
    win.removeListener('restore', restore);
    contents.removeListener('did-finish-load', restore);
    contents.removeListener('before-input-event', beforeInput);
  });
}

module.exports = { installTerminalWindowFocus };
