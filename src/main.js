const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const store = require('./codexStore');

let mainWindow;

function hasSwitch(name) {
  return process.argv.includes(`--${name}`) || app.commandLine.hasSwitch(name);
}

const isSmokeTest = hasSwitch('smoke-test');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1020,
    minHeight: 680,
    title: 'Codex 会话管家',
    backgroundColor: '#f4f6f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).then(() => {
    if (isSmokeTest) {
      console.log('smoke: window loaded');
      console.log(`smoke: menu visible ${mainWindow.isMenuBarVisible()}`);
      setTimeout(() => app.quit(), 300);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('codex:get-default-home', () => store.defaultCodexHome());

ipcMain.handle('codex:choose-home', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Codex Home 目录',
    defaultPath: store.defaultCodexHome(),
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('codex:scan', async (_event, codexHome) => store.scanCodexHome(codexHome));

ipcMain.handle('codex:plan-delete', async (_event, payload) => {
  const ids = Array.isArray(payload?.ids) ? payload.ids : [];
  return store.buildDeletePlan(payload?.codexHome, ids);
});

ipcMain.handle('codex:delete', async (event, payload) => {
  const ids = Array.isArray(payload?.ids) ? payload.ids : [];
  return store.deleteSessions({
    codexHome: payload?.codexHome,
    ids,
    confirmText: payload?.confirmText,
    vacuum: payload?.vacuum !== false,
    onProgress: (progress) => {
      event.sender.send('codex:delete-progress', progress);
    },
  });
});
