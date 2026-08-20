const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subvidDesktop', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  openFileDialog: (options) => ipcRenderer.invoke('dialog:open-file', options),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:save-file', options),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
});
