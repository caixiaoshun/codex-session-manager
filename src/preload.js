const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexManager', {
  getDefaultHome: () => ipcRenderer.invoke('codex:get-default-home'),
  chooseHome: () => ipcRenderer.invoke('codex:choose-home'),
  scan: (codexHome) => ipcRenderer.invoke('codex:scan', codexHome),
  planDelete: (payload) => ipcRenderer.invoke('codex:plan-delete', payload),
  deleteSessions: (payload) => ipcRenderer.invoke('codex:delete', payload),
  onDeleteProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('codex:delete-progress', listener);
    return () => ipcRenderer.removeListener('codex:delete-progress', listener);
  },
});
