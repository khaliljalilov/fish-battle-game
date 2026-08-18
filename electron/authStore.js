/**
 * electron/authStore.js — persists the session JWT via Electron's OS-level
 * safeStorage (DPAPI on Windows) instead of the renderer's localStorage, so
 * the token isn't plaintext-readable to anything that can read arbitrary
 * page state (e.g. a future XSS in login.html/index.html). Called only from
 * main.js's IPC handlers — the renderer reaches these through preload.js's
 * contextBridge, since it has no direct Node/Electron access
 * (contextIsolation: true, nodeIntegration: false, see main.js).
 */

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const TOKEN_FILE_NAME = 'auth-token.bin';
const REFRESH_TOKEN_FILE_NAME = 'auth-refresh-token.bin';

function tokenFilePath(userDataPath) {
  return path.join(userDataPath, TOKEN_FILE_NAME);
}

function refreshTokenFilePath(userDataPath) {
  return path.join(userDataPath, REFRESH_TOKEN_FILE_NAME);
}

/** Returns the stored token, or null if there isn't one or it can't be read. */
function readToken(userDataPath) {
  const file = tokenFilePath(userDataPath);
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function readRefreshToken(userDataPath) {
  const file = refreshTokenFilePath(userDataPath);
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function writeToken(userDataPath, token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is unavailable on this machine.');
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(tokenFilePath(userDataPath), safeStorage.encryptString(token));
}

function writeRefreshToken(userDataPath, refreshToken) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is unavailable on this machine.');
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(refreshTokenFilePath(userDataPath), safeStorage.encryptString(refreshToken));
}

function clearToken(userDataPath) {
  const file = tokenFilePath(userDataPath);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function clearRefreshToken(userDataPath) {
  const file = refreshTokenFilePath(userDataPath);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { readToken, readRefreshToken, writeToken, writeRefreshToken, clearToken, clearRefreshToken };
