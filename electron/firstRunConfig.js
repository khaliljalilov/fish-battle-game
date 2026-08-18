/**
 * electron/firstRunConfig.js — resolves the secrets/config the GAME server
 * needs when running PACKAGED, without ever shipping this developer's own
 * project-root .env inside the built app (see the `files` exclusions in
 * package.json's "build" config).
 *
 * This covers server/server.js only. src/server.js (the auth service) is
 * no longer spawned locally at all — it runs as one process on hosted
 * infrastructure the developer controls, reachable over HTTPS at
 * AUTH_API_BASE_URL below. Its own secrets (MONGO_URI, JWT_SECRET,
 * ADMIN_SECRET_KEY) live only on that host's own environment, set directly
 * by the developer there — this file never generates or ships them.
 *
 * Two different code paths, both driven from main.js by app.isPackaged:
 *
 *   DEV (npm run desktop, unpackaged): this module isn't even called.
 *   The spawned child keeps reading its own project-root .env exactly as
 *   it always has, via its own require('dotenv').config() call — this
 *   developer's real EULER_API_KEY etc. stay exactly where they are, never
 *   touched by anything in this file.
 *
 *   PACKAGED (a built .exe, handed to someone else): the project's own
 *   .env is excluded from the build entirely, so there is nothing bundled
 *   for the child's dotenv.config() to find (that call becomes a silent
 *   no-op — dotenv doesn't throw when the file's missing). Instead,
 *   resolvePackagedConfig() reads-or-creates a config file in a writable
 *   PER-USER location (Electron's userData directory, e.g.
 *   %APPDATA%/<app name>/config/ on Windows) and returns its values so
 *   serverManager.spawnService can inject them directly into the child's
 *   spawn `env`. dotenv's own default behavior — never override an
 *   already-set process.env value — is what makes this work with zero
 *   changes to server/server.js itself.
 *
 *   ADMIN_SECRET_KEY is safe to auto-generate: it's a random secret with no
 *   external dependency, generated once and then persisted so it stays
 *   stable across relaunches (a key that changes every launch would lock
 *   the recipient out of their own admin panel each time). MONGO_URL
 *   defaults to this project's own MongoDB Atlas cluster (cloud), so a
 *   packaged .exe works with no local MongoDB install on the recipient's
 *   machine at all — every install shares that one cluster unless a
 *   machine's own game.env overrides it. EULER_API_KEY is left blank on
 *   purpose: it's a personal Euler Stream account credential (see
 *   server/server.js) that genuinely can't be generated — a recipient
 *   without one simply can't start a live TikTok connection until they add
 *   their own, but the app still starts and runs fine (SIMULATE / the
 *   on-screen test panel need no Euler key at all).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Minimal KEY=value parser for this file's own simple config format — not
 *  a general .env parser, just enough for what loadOrCreate ever writes. */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function serializeEnvFile(values, header) {
  const lines = [header, ''];
  for (const [key, value] of Object.entries(values)) lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Read `filePath` if it exists, filling in any of `defaults`' keys that
 * are missing from it (so a later app update that adds a new required key
 * fills in just that key on next launch, instead of needing a full config
 * wipe) — then persist the merged result back only if something actually
 * changed, so an ordinary unchanged launch doesn't touch the file's mtime.
 *
 * `forced` keys are different: they always take the given value, even if
 * a persisted file already has something else there. That's what the Mongo
 * connection values below need — they're this app's own infrastructure,
 * not a per-recipient setting, so a stale local-Mongo default written by an
 * older build must not survive into a newer one just because the file
 * already existed. (`defaults` is still the right shape for ADMIN_SECRET_KEY
 * / JWT_SECRET / EULER_API_KEY, which must stay stable — or stay whatever
 * the recipient typed in — across relaunches.)
 */
function loadOrCreate(filePath, defaults, header, forced = {}, writeToDisk = true) {
  const existing = fs.existsSync(filePath) ? parseEnvFile(fs.readFileSync(filePath, 'utf8')) : {};

  // Sanitize sensitive keys from existing on-disk content so we never persist
  // Mongo connection information into a per-user file. This removes any
  // MONGO* keys that older builds may have written.
  const sanitizedExisting = { ...existing };
  for (const k of Object.keys(sanitizedExisting)) {
    if (k.startsWith('MONGO')) delete sanitizedExisting[k];
  }

  // Build the merged view that will be used in-memory by the child.
  const merged = { ...defaults, ...sanitizedExisting, ...forced };

  // The file should be rewritten if any default keys were missing or any
  // forced keys changed, or if sanitization removed sensitive keys that
  // previously existed on disk.
  const missingDefault = Object.keys(defaults).some((k) => !(k in existing));
  const forcedChanged = Object.keys(forced).some((k) => existing[k] !== forced[k]);
  const hadSensitive = Object.keys(existing).some((k) => k.startsWith('MONGO'));
  const changed = missingDefault || forcedChanged || hadSensitive;

  if (changed && writeToDisk) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, serializeEnvFile(merged, header));
  }
  return merged;
}

/**
 * The auth service's own public HTTPS URL (see this file's header comment).
 * Hosted on Render, deployed from the src/ directory of this project's own
 * repo. Forced (see loadOrCreate) so a future app update that changes where
 * the auth service lives propagates to existing installs automatically, the
 * same way the Mongo values below already do.
 */
const AUTH_API_BASE_URL = 'https://fish-battle-arena.onrender.com/api/auth';

/**
 * @param {string} userDataPath  Electron's app.getPath('userData').
 * @returns {{ game: object, configDir: string, adminKeyFreshlyGenerated: boolean }}
 *   `game` is a plain {ENV_VAR: value} object ready to spread into the
 *   child's spawn env. `configDir` is where it lives on disk, for showing
 *   in an error message if something's still wrong.
 *   `adminKeyFreshlyGenerated` is true only on the run that actually
 *   generated `game.ADMIN_SECRET_KEY` for the first time — main.js uses it
 *   to decide whether to show the one-time "here is your admin key" dialog.
 */
function resolvePackagedConfig(userDataPath, { writeToDisk = true } = {}) {
  const configDir = path.join(userDataPath, 'config');
  const gameEnvPath = path.join(configDir, 'game.env');

  // Per-install random admin key — checked BEFORE loadOrCreate so we can tell
  // whether an existing file already had one. If writeToDisk is false we
  // still generate a key to show the user but won't persist it to disk.
  const gameEnvExisted = fs.existsSync(gameEnvPath);
  const preExisting = gameEnvExisted ? parseEnvFile(fs.readFileSync(gameEnvPath, 'utf8')) : {};
  const adminKeyFreshlyGenerated = !preExisting.ADMIN_SECRET_KEY;

  // Atlas host/query/user should be allowed to be overridden via env at
  // package time. IMPORTANT: do NOT hardcode credentials in source. If no
  // password is provided, do not force-writing a MONGO_URL into the user's config.
  const ATLAS_HOSTS = process.env.MONGO_ATLAS_HOSTS || 'ac-t7fhqrc-shard-00-00.z5mbjwl.mongodb.net:27017,ac-t7fhqrc-shard-00-01.z5mbjwl.mongodb.net:27017,ac-t7fhqrc-shard-00-02.z5mbjwl.mongodb.net:27017';
  const ATLAS_QUERY = process.env.MONGO_ATLAS_QUERY || 'ssl=true&replicaSet=atlas-kp5iau-shard-0&authSource=admin&appName=Cluster0';
  const ATLAS_GAME_USER = process.env.MONGO_ATLAS_USER || 'fishbattle_game';
  const ATLAS_GAME_PASS = process.env.MONGO_ATLAS_PASS || '';

  // Only construct a full MONGO URL if credentials are present; otherwise
  // leave it blank so nothing sensitive is persisted without consent.
  const ATLAS_GAME_URL = ATLAS_GAME_PASS ? `mongodb://${encodeURIComponent(ATLAS_GAME_USER)}:${encodeURIComponent(ATLAS_GAME_PASS)}@${ATLAS_HOSTS}/?${ATLAS_QUERY}` : '';

  // Do NOT persist MongoDB connection strings or DB names into the
  // per-user file. These are sensitive and should not be written out by
  // default. Only non-sensitive defaults are forced into the on-disk file.
  const forced = { AUTH_API_BASE_URL };

  const game = loadOrCreate(
    gameEnvPath,
    {
      ADMIN_SECRET_KEY: randomHex(16),
      EULER_API_KEY: ''
    },
    '# Fish Battle — game server config, generated on first run.\n'
    + '# ADMIN_SECRET_KEY was generated for this install and shown to you once —\n'
    + '# see it again here if needed for the admin panel.\n'
    + '# EULER_API_KEY is required only for a LIVE TikTok connection — get a free\n'
    + '# one at https://www.eulerstream.com and paste it in below. Everything else\n'
    + '# (the on-screen test panel, offline play) works without it.',
    forced,
    writeToDisk
  );

  // Give the child process the Mongo connection in-memory but do not write
  // it to disk. This way a packaged exe can still connect (when the packager
  // provides ATLAS credentials via env) but the per-user game.env won't
  // contain the cluster credentials.
  const gameEnv = { ...game };
  if (ATLAS_GAME_URL) gameEnv.MONGO_URL = ATLAS_GAME_URL;
  gameEnv.MONGO_DB = 'tiktok_fish_battle';

  return { game: gameEnv, configDir, adminKeyFreshlyGenerated };
}

module.exports = { resolvePackagedConfig };
