/**
 * electron/main.js — desktop shell with server lifecycle.
 *
 * Spawns the game server itself (server/server.js, port 3000 — see
 * serverManager.js), waits for it to actually answer before showing any
 * window, and kills it cleanly on quit. The auth service (src/server.js) is
 * NOT spawned here — it runs as one process on hosted infrastructure the
 * developer controls, reachable over HTTPS at AUTH_API_BASE_URL
 * (firstRunConfig.js). See git history for the earlier version that also
 * spawned it locally, and firstRunConfig.js's header comment for why that
 * changed.
 */

const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, clipboard } = require('electron');
const { spawnService, waitForHealthy, killService } = require('./serverManager');
const { resolvePackagedConfig } = require('./firstRunConfig');
const authStore = require('./authStore');

// public/assets/icon.ico ships automatically — it's copied byte-for-byte by
// tools/obfuscate.js (public/ -> build/obfuscated/public) and packaged via
// package.json build.files, so this path resolves the same way in dev and
// inside app.asar. The .exe itself gets its icon baked in separately by
// electron-builder's build.win.icon (build/icon.ico); this only covers the
// BrowserWindow/taskbar icon while the app is running.
const APP_ICON = path.join(__dirname, '../public/assets/icon.ico');

const GAME_PORT = 3000;
/**
 * Hardcoded, not read from .env — same assumption the previous thin-shell
 * version already made (GAME_URL was already a fixed localhost:3000
 * literal). A user with a custom PORT in their .env will need this changed
 * to match; reading it properly means parsing the child's own .env file
 * from the main process too, which is more than this lifecycle step needs.
 */
const GAME_URL = `http://localhost:${GAME_PORT}/login.html`;

// Disables Chromium's on-disk HTTP cache entirely for this app. Must be set
// before the app is ready — this is the real mechanism for "no HTTP caching"
// in Electron. (setPermissionRequestHandler, mentioned in the original ask
// for this, is unrelated: it decides whether to grant camera/mic/geolocation/
// notification requests, not caching. Passing () => true there would
// silently auto-grant every permission any page in this window ever asks
// for — a real vulnerability, not a caching fix — so it's not used for this.
// See the deny-by-default handler below instead, which is the actually
// correct use of that API.)
app.commandLine.appendSwitch('disable-http-cache');

/** The one child process, so app-quit handlers can reach it. */
const services = { game: null };

// Backs window.electronAuthStore (see preload.js) — the renderer has no
// direct access to safeStorage, so it goes through these three IPC calls.
ipcMain.handle('auth:getToken', () => authStore.readToken(app.getPath('userData')));
ipcMain.handle('auth:setToken', (_event, token) => {
  authStore.writeToken(app.getPath('userData'), token);
  return true;
});
ipcMain.handle('auth:clearToken', () => {
  authStore.clearToken(app.getPath('userData'));
  return true;
});
ipcMain.handle('auth:getRefreshToken', () => authStore.readRefreshToken(app.getPath('userData')));
ipcMain.handle('auth:setRefreshToken', (_event, refreshToken) => {
  authStore.writeRefreshToken(app.getPath('userData'), refreshToken);
  return true;
});
ipcMain.handle('auth:clearRefreshToken', () => {
  authStore.clearRefreshToken(app.getPath('userData'));
  return true;
});

async function stopServices() {
  await killService(services.game);
}

/** Spawn the game server and wait for it to answer /api/health before returning. */
async function startServices() {
  // Dev: cwd defaults to the real project root (spawnService's own
  // default) and env is untouched — the child keeps reading its own
  // project-root .env exactly as always, this developer's real secrets
  // included.
  //
  // Packaged: that .env is never bundled at all (see package.json
  // "build".files), so cwd MUST be a real, existing directory — an asar
  // path isn't one — and the child's env is pre-populated from a
  // generated-on-first-run, per-recipient config file instead. See
  // firstRunConfig.js for why this needs no changes to the child script.
  let spawnOpts = {};
  if (app.isPackaged) {
    const cwd = process.resourcesPath;

    // Automatic behavior: sanitize any existing per-user file and persist the
    // cleaned config. This will remove Mongo credentials from any existing
    // game.env and ensure future on-disk files don't contain them.
    const { game, configDir, adminKeyFreshlyGenerated } = resolvePackagedConfig(app.getPath('userData'), { writeToDisk: true });
    spawnOpts = { cwd, env: game };

    if (adminKeyFreshlyGenerated) {
      const resp = await dialog.showMessageBox({
        type: 'info',
        title: 'Fish Battle — Admin Key',
        message: 'Your local admin key has been generated.',
        detail: `${game.ADMIN_SECRET_KEY}\n\n`
          + 'Paste this into the admin panel\'s key field to reset the arena or '
          + 'connect/disconnect TikTok. Shown once — it is saved at:\n'
          + `${configDir}\\game.env`,
        buttons: ['Copy key', 'OK'],
        defaultId: 0,
        cancelId: 1
      });
      if (resp.response === 0) {
        try {
          clipboard.writeText(game.ADMIN_SECRET_KEY);
          await dialog.showMessageBox({ type: 'info', message: 'Admin key copied to clipboard.', buttons: ['OK'] });
        } catch (e) {
          await dialog.showMessageBox({ type: 'error', message: 'Failed to copy the admin key to clipboard. Please copy it manually from the dialog.', detail: game.ADMIN_SECRET_KEY, buttons: ['OK'] });
        }
      }
    }
  }

  services.game = spawnService('game-server', 'server/server.js', spawnOpts);
  await waitForHealthy(`http://localhost:${GAME_PORT}/api/health`, services.game);
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#04101a', // matches --abyss, avoids a white flash on load
    autoHideMenuBar: true,
    icon: APP_ICON,
    show: false, // stays hidden until the game server is confirmed healthy — see startServices()
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // This app never needs camera/mic/geolocation/notifications — deny by
  // default rather than leaving Electron's built-in default behavior implicit.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // Belt-and-suspenders on top of the command-line switch above: wipe
  // anything already cached for this session before the first load, so a
  // previous run's stale login.html/index.html can never be served.
  await win.webContents.session.clearCache();

  win.once('ready-to-show', () => win.show());
  win.loadURL(GAME_URL);
}

/**
 * A friendlier message for the single most common startup failure (another
 * copy of the server already running, or a leftover process from a previous
 * crashed launch still holding the port) on top of the raw captured output,
 * which is shown regardless so anything else (missing .env, Mongo down)
 * is still fully visible.
 */
function explainFailure(err) {
  const raw = err.message || String(err);
  if (/EADDRINUSE/.test(raw)) {
    return `A server is already using the port this app needs (3000).\n`
      + `Close any other running copy of this app or "npm start" process, then try again.\n\n${raw}`;
  }
  // Defense in depth: firstRunConfig.js auto-generates every required
  // secret, so this "shouldn't" happen when packaged — but if the config
  // directory turned out to be unwritable (permissions, disk full) the
  // child would still hit its own [fatal] "X is not set" check and exit.
  // Point at where that config actually lives rather than leaving the
  // recipient staring at a raw stack trace with no idea what a ".env" is.
  if (app.isPackaged && /\[fatal\].*is not set/.test(raw)) {
    return `Startup configuration is missing or unwritable.\n`
      + `Check that this app can write to:\n${app.getPath('userData')}\\config\\\n\n${raw}`;
  }
  return raw;
}

app.whenReady().then(async () => {
  try {
    await startServices();
  } catch (err) {
    dialog.showErrorBox('Fish Battle failed to start', explainFailure(err));
    await stopServices();
    app.quit();
    return;
  }

  await createWindow();

  // macOS convention: clicking the dock icon with no windows open reopens one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Covers every quit path (window close, Cmd+Q, app.quit() from the error
// handler above) — without this, the two child node processes outlive the
// Electron window and pile up across repeated launches.
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  stopServices().finally(() => app.exit());
});
