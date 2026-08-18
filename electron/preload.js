/**
 * electron/preload.js — the only bridge between the sandboxed renderer
 * (contextIsolation: true, nodeIntegration: false — see main.js) and
 * Node/Electron APIs.
 *
 * Exposes window.electronAuthStore, which public/js/tokenStore.js uses in
 * place of localStorage whenever it's present. A bare browser tab opened
 * outside Electron never gets this bridge and falls back to localStorage
 * instead — see tokenStore.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAuthStore', {
  getToken: () => ipcRenderer.invoke('auth:getToken'),
  setToken: (token) => ipcRenderer.invoke('auth:setToken', token),
  clearToken: () => ipcRenderer.invoke('auth:clearToken'),
  getRefreshToken: () => ipcRenderer.invoke('auth:getRefreshToken'),
  setRefreshToken: (refreshToken) => ipcRenderer.invoke('auth:setRefreshToken', refreshToken),
  clearRefreshToken: () => ipcRenderer.invoke('auth:clearRefreshToken')
});
