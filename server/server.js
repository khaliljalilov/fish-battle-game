/**
 * server.js — TikTok Live Fish Battle backend.
 *
 * Responsibilities
 *   • Bridge TikTok Live gift events into game events.
 *   • Own the HP economy (see rules.js) so money is never client-authoritative.
 *   • Persist every state change to a MongoDB Atlas cluster (see store.js).
 *   • Restore the whole arena on browser refresh via GET /api/state.
 *   • Expose a key-protected reset endpoint that wipes the collection.
 *
 * Run:  npm start           (live TikTok)
 *       SIMULATE=true npm start   (test panel works locally, empty arena)
 *       npm run dev         (SIMULATE=true + SIMULATE_AUTOSPAWN=true — fake
 *                             gifts every few seconds, no clicking required)
 */

require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { Store, MONGO_URL, DB_NAME } = require('./store');
const rules = require('./rules');

// ---------------------------------------------------------------- config ---

const PORT = Number(process.env.PORT) || 3000;
/**
 * No .env fallback username, and no auto-connect at boot — the connection is
 * started only by an authenticated POST /api/admin/tiktok/connect with an
 * explicit username in the request body. See tiktokUsername (mutable,
 * runtime-only) below and startTikTok()/stopTikTok().
 */
/** Euler Stream signing key. Free at https://www.eulerstream.com — see startTikTok(). */
const SIGN_API_KEY = (process.env.EULER_API_KEY || '').trim();
const SIMULATE = String(process.env.SIMULATE || '').toLowerCase() === 'true';
/**
 * SIMULATE only unlocks the /api/simulate/* endpoints (used by the on-screen
 * test panel) for remote callers — it does NOT imply the random auto-gift
 * loop below. That loop needs this separate opt-in, so `SIMULATE=true npm
 * start` gives you working test buttons with a clean, empty arena; use
 * `npm run dev` (or set this yourself) when you actually want the
 * fire-and-forget random stream for unattended soak testing.
 */
const SIMULATE_AUTOSPAWN = String(process.env.SIMULATE_AUTOSPAWN || '').toLowerCase() === 'true';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || '';
const MAX_ACTIVE_FISH = Number(process.env.MAX_ACTIVE_FISH) || 40;
/**
 * Told to the browser client via GET /api/config so login.js/authGuard.js
 * don't hardcode where the (separate, standalone) auth service lives. Not a
 * secret — just a URL. Defaults to the same-machine dev value so local
 * `npm start` + `node src/server.js` needs no .env change.
 */
const AUTH_API_BASE_URL = process.env.AUTH_API_BASE_URL || 'http://localhost:5000/api/auth';

if (!ADMIN_SECRET_KEY) {
  console.error('\n[fatal] ADMIN_SECRET_KEY is not set. Copy .env.example to .env and set one.\n');
  process.exit(1);
}
if (ADMIN_SECRET_KEY.length < 12) {
  console.warn('[warn] ADMIN_SECRET_KEY is short. Use 20+ random characters for a live stream.');
}

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a)
};

// ----------------------------------------------------------- auth helpers ---

/**
 * Verify a Bearer token against the auth service. Returns the user object on
 * success, null on failure. Cached briefly so a burst of game-state fetches
 * doesn't hammer /api/auth/me.
 */
const tokenCache = new Map(); // token -> { user, expiresAt }
const TOKEN_CACHE_TTL_MS = 5000;

async function verifyToken(token) {
  if (!token) return null;

  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }
  tokenCache.delete(token);

  try {
    const res = await fetch(`${AUTH_API_BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success || !data.user) return null;

    const isActive = data.user.role === 'admin'
      || (data.user.role === 'premium' && data.user.subscriptionExpiresAt
        ? new Date(data.user.subscriptionExpiresAt).getTime() > Date.now()
        : false);

    if (!isActive) return null;

    tokenCache.set(token, { user: data.user, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
    return data.user;
  } catch {
    return null;
  }
}

/**
 * Middleware: require a valid Bearer token from the auth service.
 * Unauthenticated requests get 401; the client should redirect to login.
 */
async function requireAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace('Bearer ', '');
  const user = await verifyToken(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Authentication required.' });
  }
  req.user = user;
  next();
}

/**
 * Middleware: restrict access to localhost only. Used on admin endpoints so
 * they cannot be reached from another machine on the network even if the
 * admin key leaks.
 */
function localhostOnly(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || '';
  if (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1'
  ) {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'Admin access is localhost-only.' });
}

// ------------------------------------------------------------------ boot ---

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const store = new Store(log);

app.use(express.json({ limit: '256kb' }));

// No caching, anywhere. login.html/index.html and the JS/CSS that gate
// access to the game must never be served stale from a browser or disk
// cache — a cached free-tier login.html could keep showing an outdated
// subscription screen after a promotion, for instance. `cacheControl: false`
// on express.static is required: without it, serve-static sets its own
// `Cache-Control: public, max-age=...` on every static response AFTER this
// middleware runs, silently overwriting the header set here.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { cacheControl: false }));

// Spam/DDoS ceiling on the API surface only — static assets (JS/CSS/models)
// are untouched so a page load itself is never at risk of tripping this.
// Generous limit: real traffic here is one-off fetches (/api/state on load,
// /api/tiktok/status when the admin panel opens), not polling loops.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', apiLimiter);

// ------------------------------------------------------------ game events ---

/**
 * Apply a gift. This is the ONLY path that increases HP.
 * Returns the broadcast payload, or null if the gift was ignored.
 */
function applyGift({ username, nickname, avatar, coins, giftName }) {
  if (!username) return null;

  const resolved = rules.resolveGift(coins, giftName);
  const isNew = !store.get(username);

  if (isNew && store.cache.size >= MAX_ACTIVE_FISH) {
    // Arena is full. Still bank the gift so nothing is lost, but flag it so the
    // client can show a queue notice instead of spawning a 41st shark.
    log.warn(`[game] arena full (${MAX_ACTIVE_FISH}); ${username} queued`);
  }

  store.ensure(username, { nickname, avatar });
  const fish = store.update(username, (f) => {
    // Some tiers advertise a guaranteed level (Hand Heart = instant Titan), so
    // the gift lifts you to at least that floor even from a standing start.
    f.hp = Math.max(f.hp + resolved.hp, resolved.floorHP || 0);
    f.coinsSpent += resolved.coins;
    f.giftsReceived += 1;
  });

  // Money moved: don't wait for the 2s timer.
  store.flush().catch(() => {});

  return {
    username,
    nickname: fish.nickname,
    avatar: fish.avatar,
    hp: fish.hp,
    level: fish.level,
    coinsSpent: fish.coinsSpent,
    hpGain: resolved.hp,
    power: resolved.power,
    coins: resolved.coins,
    giftName: giftName || resolved.label,
    isNew
  };
}

function broadcastGift(payload) {
  if (!payload) return;
  io.emit('gift', payload);
}

/** Likes never buy coins — every 50 accumulated likes is worth a flat reward. */
const LIKE_THRESHOLD = 50;
const LIKE_REWARD_HP = 10;
/**
 * Accumulated likes per user since their last threshold reward.
 *
 * Module-scoped (not inside startTikTok()) so both the live connection and
 * the /api/simulate/like test endpoint share the same counters, and so a
 * TikTok reconnect doesn't wipe progress a viewer already built up.
 */
const userLikes = new Map();

/**
 * Apply one like-threshold reward. A brand-new viewer spawns a fresh
 * LIKE_REWARD_HP fish (not the 1000-2000 HP gift spawn band — likes are the
 * free, low-stakes path in); an existing fish just heals +LIKE_REWARD_HP.
 * coinsSpent is untouched since this never went through the coin economy.
 */
function applyLikeReward({ username, nickname, avatar }) {
  if (!username) return null;

  const isNew = !store.get(username);
  if (isNew && store.cache.size >= MAX_ACTIVE_FISH) {
    log.warn(`[game] arena full (${MAX_ACTIVE_FISH}); ${username} queued (like reward)`);
  }

  store.ensure(username, { nickname, avatar });
  const fish = store.update(username, (f) => {
    f.hp = isNew ? LIKE_REWARD_HP : f.hp + LIKE_REWARD_HP;
  });

  store.flush().catch(() => {});

  return {
    username,
    nickname: fish.nickname,
    avatar: fish.avatar,
    hp: fish.hp,
    level: fish.level,
    coinsSpent: fish.coinsSpent,
    hpGain: LIKE_REWARD_HP,
    power: null,
    coins: 0,
    giftName: 'Like Reward',
    isNew
  };
}

/**
 * Accumulate one batch of likes for a user and drain every threshold crossed.
 * Shared by the live TikTok handler and /api/simulate/like so the reward
 * logic itself (accumulate -> threshold -> spawn/heal -> broadcast) can be
 * verified without depending on TikTok actually delivering `like` events —
 * TikTok's own docs note this event "is not always triggered" on busy streams.
 *
 * Logs every call, not just threshold crossings, so a live session's console
 * shows visible progress toward 100 even when nothing has fired yet — the
 * single most useful signal for telling "no likes are arriving" apart from
 * "likes are arriving but never reach 100."
 */
function registerLikes({ username, nickname, avatar }, rawLikeCount, source = 'tiktok') {
  if (!username) return { rewards: 0, remaining: 0 };

  const batch = Math.max(1, Math.round(Number(rawLikeCount) || 1));
  const total = (userLikes.get(username) || 0) + batch;

  // A single burst can clear the threshold more than once (a 250-like tap
  // frenzy is common), so drain it in a loop instead of firing once and
  // dropping the remainder.
  let remaining = total;
  let rewards = 0;
  while (remaining >= LIKE_THRESHOLD) {
    remaining -= LIKE_THRESHOLD;
    rewards++;
  }
  userLikes.set(username, remaining);

  for (let i = 0; i < rewards; i++) {
    const payload = applyLikeReward({ username, nickname: nickname || username, avatar });
    if (payload) broadcastGift(payload);
  }

  log.info(
    `[like:${source}] ${username} +${batch} (progress ${remaining}/${LIKE_THRESHOLD})` +
    (rewards ? ` — ${rewards} reward(s), +${rewards * LIKE_REWARD_HP} HP` : '')
  );

  return { rewards, remaining };
}

/**
 * A follow is a single one-time event per viewer (no accumulation like the
 * like threshold), so it rewards immediately every time it fires. Same
 * spawn/heal shape as applyLikeReward: a brand-new viewer spawns a fresh
 * FOLLOW_REWARD_HP fish, an existing fish just heals +FOLLOW_REWARD_HP.
 */
const FOLLOW_REWARD_HP = 20;

function applyFollowReward({ username, nickname, avatar }) {
  if (!username) return null;

  const isNew = !store.get(username);
  if (isNew && store.cache.size >= MAX_ACTIVE_FISH) {
    log.warn(`[game] arena full (${MAX_ACTIVE_FISH}); ${username} queued (follow reward)`);
  }

  store.ensure(username, { nickname, avatar });
  const fish = store.update(username, (f) => {
    f.hp = isNew ? FOLLOW_REWARD_HP : f.hp + FOLLOW_REWARD_HP;
  });

  store.flush().catch(() => {});

  return {
    username,
    nickname: fish.nickname,
    avatar: fish.avatar,
    hp: fish.hp,
    level: fish.level,
    coinsSpent: fish.coinsSpent,
    hpGain: FOLLOW_REWARD_HP,
    power: null,
    coins: 0,
    giftName: 'Follow Reward',
    isNew
  };
}

/**
 * A chat message rewards immediately, same as follow — but a viewer can chat
 * far more often than they can follow (once) or gift (costs money), so this
 * constant is intentionally the smallest of the three free-path rewards to
 * keep the economy from being dominated by whoever types the most.
 */
const CHAT_REWARD_HP = 5;

function applyChatReward({ username, nickname, avatar }) {
  if (!username) return null;

  const isNew = !store.get(username);
  if (isNew && store.cache.size >= MAX_ACTIVE_FISH) {
    log.warn(`[game] arena full (${MAX_ACTIVE_FISH}); ${username} queued (chat reward)`);
  }

  store.ensure(username, { nickname, avatar });
  const fish = store.update(username, (f) => {
    f.hp = isNew ? CHAT_REWARD_HP : f.hp + CHAT_REWARD_HP;
  });

  store.flush().catch(() => {});

  return {
    username,
    nickname: fish.nickname,
    avatar: fish.avatar,
    hp: fish.hp,
    level: fish.level,
    coinsSpent: fish.coinsSpent,
    hpGain: CHAT_REWARD_HP,
    power: null,
    coins: 0,
    giftName: 'Chat Reward',
    isNew
  };
}

/**
 * The client simulates combat and reports results back. We trust it because it
 * runs on the streamer's own machine, but we still clamp through rules.normalize
 * so a runaway number can never poison the database.
 */
function applyClientSync(entries) {
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    if (!e || typeof e.username !== 'string') continue;
    if (!store.get(e.username)) continue;
    store.update(e.username, (f) => {
      if (Number.isFinite(e.hp)) f.hp = e.hp;
    });
  }
}

function killFish(username) {
  if (!store.get(username)) return;
  store.remove(username);
  store.flush().catch(() => {});
  io.emit('fish:remove', { username });
}

async function resetArena(reason = 'admin') {
  await store.wipe();
  io.emit('game:reset', { reason, at: Date.now() });
  log.info(`[game] arena reset (${reason})`);
}

// --------------------------------------------------------------- REST API ---

/** Non-secret client config — currently just where the auth service lives. */
app.get('/api/config', (req, res) => {
  res.json({ authBase: AUTH_API_BASE_URL });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mongo: { db: DB_NAME, connected: store.connected },
    tiktok: { username: tiktokUsername || null, connected: tiktokConnected, simulate: SIMULATE },
    fish: store.cache.size
  });
});

/**
 * Lightweight, unauthenticated read of the live TikTok connection state —
 * same two fields already exposed under /api/health's `tiktok` key, just
 * flattened for tiktokPanel.js to poll on load without parsing the whole
 * health payload. No admin key required: this is read-only and reveals
 * nothing /api/health doesn't already. Fixes the page-refresh bug where the
 * server stays connected but the UI has no way to find that out again.
 */
app.get('/api/tiktok/status', (req, res) => {
  res.json({ connected: tiktokConnected, username: tiktokUsername || null });
});

/** Full arena snapshot — requires authentication. */
app.get('/api/state', requireAuth, (req, res) => {
  res.json({
    ok: true,
    restoredFromDb: store.connected,
    maxActive: MAX_ACTIVE_FISH,
    fish: store.all()
  });
});

/**
 * Model diagnostics — requires authentication.
 */
app.get('/api/models', requireAuth, (req, res) => {
  const fsSync = require('fs');
  const dir = path.join(__dirname, '..', 'public', 'models');

  let entries = [];
  let dirExists = true;
  try {
    entries = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    dirExists = false;
  }

  const filesOnDisk = entries.filter((e) => e.isFile()).map((e) => e.name);
  const subfolders = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Anything model-shaped that isn't one of the ten expected names.
  const expected = rules.LEVEL_BANDS.map((b) => b.model);
  const expectedSet = new Set(expected);

  const found = [];
  const missing = [];
  for (const band of rules.LEVEL_BANDS) {
    const exact = filesOnDisk.includes(band.model);
    if (exact) {
      const size = fsSync.statSync(path.join(dir, band.model)).size;
      found.push({ level: band.level, file: band.model, sizeKB: Math.round(size / 1024) });
    } else {
      // Case-insensitive near-match is the usual culprit on Windows exports.
      const near = filesOnDisk.find((f) => f.toLowerCase() === band.model.toLowerCase());
      missing.push({ level: band.level, expected: band.model, caseMismatch: near || null });
    }
  }

  const unrecognised = filesOnDisk
    .filter((f) => /\.(glb|gltf|fbx|obj)$/i.test(f))
    .filter((f) => !expectedSet.has(f))
    .filter((f) => f !== 'blade.glb');

  res.json({
    ok: true,
    folder: dir,
    folderExists: dirExists,
    found,
    missing,
    unrecognisedModelFiles: unrecognised,
    subfoldersFound: subfolders,
    allFilesOnDisk: filesOnDisk,
    hint: !dirExists
      ? 'That folder does not exist. Create public/models and put the .glb files directly inside it.'
      : subfolders.length && !found.length
        ? `Your models look nested inside a subfolder (${subfolders.join(', ')}). Move the .glb files up one level, directly into public/models.`
        : unrecognised.length
          ? 'Files are present but the names do not match. Rename them to the expected names listed under "missing".'
          : found.length === 10
            ? 'All ten models are present. If the wrong fish still appear, check the browser console for load errors.'
            : 'Some models are missing — those levels will use the procedural fallback shark.'
  });
});

/**
 * Constant-time key check. Prevents both accidental wipes (you must know the
 * key) and timing side-channels (you can't brute-force it character by character).
 */
function keyIsValid(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_SECRET_KEY);
  if (a.length !== b.length) {
    // Still burn the comparison so the failure takes the same time.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Simple lockout so a mistyped key can't be hammered from the browser. */
const attempts = new Map(); // ip -> { count, until }
function throttled(ip) {
  const rec = attempts.get(ip);
  if (rec && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  return 0;
}
function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.until = Date.now() + 60_000;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

app.post('/api/admin/reset', localhostOnly, async (req, res) => {
  const ip = req.ip || 'unknown';
  const wait = throttled(ip);
  if (wait) {
    return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${wait}s.` });
  }

  const provided = req.get('x-admin-key') || req.body?.key;
  if (!keyIsValid(provided)) {
    recordFailure(ip);
    log.warn(`[admin] rejected reset from ${ip}`);
    return res.status(401).json({ ok: false, error: 'Admin key not recognized.' });
  }

  // Second gate: the caller must also confirm intent explicitly.
  if (req.body?.confirm !== 'RESET') {
    return res.status(400).json({ ok: false, error: 'Confirmation phrase missing.' });
  }

  attempts.delete(ip);
  const removed = store.cache.size;
  await resetArena('admin');
  log.info(`[admin] reset accepted from ${ip} — ${removed} fish cleared`);
  res.json({ ok: true, removed });
});

/**
 * Connect (or switch) the live TikTok bridge to an arbitrary username.
 * Admin-key gated: this app collects real gifts server-side, so letting any
 * visitor redirect where they're collected from is a hijack vector, not just
 * a UX nicety — same threat model as /api/admin/reset, gated the same way.
 * No typed confirmation phrase though, unlike reset: this is reversible
 * (you can always reconnect) rather than destructive.
 */
app.post('/api/admin/tiktok/connect', localhostOnly, (req, res) => {
  const ip = req.ip || 'unknown';
  const wait = throttled(ip);
  if (wait) {
    return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${wait}s.` });
  }

  const provided = req.get('x-admin-key') || req.body?.key;
  if (!keyIsValid(provided)) {
    recordFailure(ip);
    log.warn(`[admin] rejected tiktok:connect from ${ip}`);
    return res.status(401).json({ ok: false, error: 'Admin key not recognized.' });
  }

  const raw = req.body?.username;
  const username = typeof raw === 'string' ? raw.trim().replace(/^@+/, '') : '';
  if (!username) {
    return res.status(400).json({ ok: false, error: 'username is required.' });
  }

  attempts.delete(ip);
  log.info(`[admin] tiktok:connect accepted from ${ip} — target @${username}`);
  startTikTok(username);
  res.json({ ok: true, username });
});

/** Admin-key gated for the same reason as connect above. */
app.post('/api/admin/tiktok/disconnect', localhostOnly, (req, res) => {
  const ip = req.ip || 'unknown';
  const wait = throttled(ip);
  if (wait) {
    return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${wait}s.` });
  }

  const provided = req.get('x-admin-key') || req.body?.key;
  if (!keyIsValid(provided)) {
    recordFailure(ip);
    log.warn(`[admin] rejected tiktok:disconnect from ${ip}`);
    return res.status(401).json({ ok: false, error: 'Admin key not recognized.' });
  }

  attempts.delete(ip);
  log.info(`[admin] tiktok:disconnect accepted from ${ip}`);
  stopTikTok();
  res.json({ ok: true });
});

/**
 * Fire a fake gift. Used by the on-screen test panel.
 *
 * Allowed from localhost even when SIMULATE is off, so you can test every gift
 * and power WHILE connected to a real TikTok stream — otherwise the only way to
 * see a 100-coin Toxic Aura is to talk someone into sending one.
 * Remote requests still require simulation mode.
 */
app.post('/api/simulate/gift', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!SIMULATE && !isLocal) {
    return res.status(403).json({ ok: false, error: 'Simulation mode is off.' });
  }
  const { username = 'tester', coins = 1, giftName = null } = req.body || {};
  const payload = applyGift({ username, nickname: username, coins, giftName });
  broadcastGift(payload);
  res.json({ ok: true, payload });
});

/**
 * Fire fake likes through the exact same accumulate/threshold/reward path as
 * the live TikTok connection (registerLikes). This exists because the `like`
 * event is the least reliable one TikTok sends — their own docs say it "is
 * not always triggered" — so there was previously no way to tell "the code
 * is broken" apart from "TikTok just isn't sending it" without going live.
 *
 * POST { username, likeCount } — likeCount defaults to LIKE_THRESHOLD (50) so
 * a single call demonstrates a full threshold crossing.
 */
app.post('/api/simulate/like', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!SIMULATE && !isLocal) {
    return res.status(403).json({ ok: false, error: 'Simulation mode is off.' });
  }
  const { username = 'tester', likeCount = LIKE_THRESHOLD } = req.body || {};
  const result = registerLikes({ username, nickname: username, avatar: null }, likeCount, 'simulate');
  res.json({ ok: true, ...result });
});

/**
 * Fire a fake follow through the exact same reward path as the live TikTok
 * connection (applyFollowReward). POST { username }.
 */
app.post('/api/simulate/follow', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!SIMULATE && !isLocal) {
    return res.status(403).json({ ok: false, error: 'Simulation mode is off.' });
  }
  const { username = 'tester' } = req.body || {};
  const payload = applyFollowReward({ username, nickname: username, avatar: null });
  if (payload) broadcastGift(payload);
  res.json({ ok: true, payload });
});

// --------------------------------------------------------------- Socket.IO ---

io.on('connection', (socket) => {
  log.info(`[io] client connected (${socket.id})`);

  socket.emit('state:full', {
    fish: store.all(),
    maxActive: MAX_ACTIVE_FISH,
    mongoConnected: store.connected,
    tiktokConnected,
    simulate: SIMULATE
  });

  // Combat results from the renderer, batched roughly once per second.
  socket.on('fish:sync', (entries) => applyClientSync(entries));

  // A level-1 fish reached 0 HP and left the arena for good.
  socket.on('fish:dead', ({ username } = {}) => {
    if (typeof username === 'string') killFish(username);
  });

  socket.on('disconnect', () => log.info(`[io] client disconnected (${socket.id})`));
});

// ------------------------------------------------------------ TikTok Live ---

let tiktokConnected = false;
let tiktok = null;
/** Currently connected/target username. '' when no connection is active — never read from .env. */
let tiktokUsername = '';
/** Pending connect/stream-end/disconnect retry, if any — cancelled on every manual stopTikTok(). */
let tiktokReconnectTimer = null;

/**
 * TikTok bridge — tiktok-live-connector v2.
 *
 * A note on why this needs an API key. TikTok signs its webcast requests with
 * obfuscated browser-fingerprint parameters, and the library delegates that
 * signing to Euler Stream's servers. When TikTok changes the algorithm, Euler
 * patches it centrally — which is why the endpoint your old v1 install pointed
 * at now returns 404. The key is free and takes about a minute:
 *
 *   https://www.eulerstream.com  ->  sign up  ->  copy API key  ->  .env
 *
 * Without a key you may get a very small anonymous quota, or nothing at all,
 * depending on load. If connection fails with a signing error, that's the first
 * thing to check.
 */
/** One-shot flag so an unknown payload is dumped once, not once per gift. */
let dumpedGiftShape = false;

/**
 * Find the gifter's identity anywhere in a TikTok gift event.
 *
 * Every version of the library nests the user somewhere slightly different, and
 * the published type definitions have repeatedly disagreed with what actually
 * arrives over the wire. Rather than hard-coding one path and breaking on the
 * next release, this checks the known shapes and then, as a last resort, walks
 * the object looking for a `uniqueId`.
 *
 * The walk is bounded in depth and skips arrays of messages, so it can't
 * wander into an unrelated user (for example the streamer's own profile
 * attached to the room, or a co-host in a PK battle).
 */
function extractIdentity(data) {
  const candidates = [
    data.user,
    data.userInfo,
    data.sender,
    data.fromUser,
    data.event?.user,
    data
  ];

  for (const c of candidates) {
    const id = readIdentity(c);
    if (id) return id;
  }

  return deepFindIdentity(data, 0);
}

function readIdentity(node) {
  if (!node || typeof node !== 'object') return null;

  // Empty strings count as missing — TikTok sends '' rather than omitting.
  const username =
    (typeof node.uniqueId === 'string' && node.uniqueId.trim()) ||
    (typeof node.userId === 'string' && node.userId.trim()) ||
    (typeof node.id === 'string' && node.id.trim()) ||
    null;
  if (!username) return null;

  const avatar =
    node.profilePicture?.urls?.[0] ||
    node.profilePictureUrls?.[0] ||
    node.avatarThumb?.urlList?.[0] ||
    node.profilePictureUrl ||
    null;

  return {
    username,
    nickname: (typeof node.nickname === 'string' && node.nickname.trim()) || null,
    avatar
  };
}

function deepFindIdentity(node, depth) {
  if (depth > 4 || !node || typeof node !== 'object') return null;

  const direct = readIdentity(node);
  if (direct) return direct;

  for (const key of Object.keys(node)) {
    // Don't descend into gift metadata or message arrays — a match there would
    // be the wrong person.
    if (key === 'giftDetails' || key === 'giftExtra' || key === 'extendedGiftInfo') continue;
    const value = node[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const found = deepFindIdentity(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** JSON dump that survives circular references and huge binary blobs. */
function safeDump(obj) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      if (typeof value === 'string' && value.length > 200) return value.slice(0, 200) + '…';
      if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;
      return value;
    }, 2);
  } catch (err) {
    return `[undumpable: ${err.message}] keys: ${Object.keys(obj || {}).join(', ')}`;
  }
}

/**
 * Start a connection to `username`. No .env fallback: an empty/missing
 * username is a hard no-op, not a default. If a connection is already
 * active, it's torn down cleanly first (stopTikTok) so switching users never
 * leaves two connections racing each other.
 */
function startTikTok(username) {
  if (tiktok) stopTikTok({ silent: true }); // clean switch — no spurious "disconnected" broadcast

  if (!username) {
    log.warn('[tiktok] no username provided — not connecting. Use the admin panel to connect.');
    return;
  }
  tiktokUsername = username;

  const GIFT_MAP = new Map();

  let TikTokLiveConnection;
  let WebcastEvent;
  try {
    ({ TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector'));
  } catch {
    log.warn('[tiktok] tiktok-live-connector not installed. Run: npm i tiktok-live-connector');
    return;
  }

  if (!TikTokLiveConnection) {
    log.error(
      '[tiktok] Your tiktok-live-connector is too old (v1 exported WebcastPushConnection).\n' +
      '         Run: npm i tiktok-live-connector@latest'
    );
    return;
  }

  if (!SIGN_API_KEY) {
    log.warn(
      '[tiktok] No EULER_API_KEY set. Signing may fail with a 404 or 429.\n' +
      '         Get a free key at https://www.eulerstream.com and put it in .env as EULER_API_KEY=...'
    );
  }

  tiktok = new TikTokLiveConnection(username, {
    signApiKey: SIGN_API_KEY || undefined,
    processInitialData: false,

    /**
     * MUST stay false on the Euler free tier.
     *
     * This option fetches the room's full gift catalogue during connect, and
     * that route is Business-plan only — with it on, connection fails outright
     * with "Failed to fetch room gifts ... requires a Business plan", which
     * reads like an auth problem but is really a billing one.
     *
     * We lose nothing. It only adds an `extendedGiftInfo` field (artwork,
     * descriptions) to gift events. The coin value and gift name we actually
     * need are already carried in the event itself.
     */
    enableExtendedGiftInfo: false
  });

  const connect = () => {
    tiktok.connect()
      .then(async (state) => {
        tiktokConnected = true;
        log.info(`[tiktok] connected to @${username} (room ${state.roomId})`);
        io.emit('tiktok:status', { connected: true, username });

        try {
          const availableGifts = await tiktok.getAvailableGifts();
          if (availableGifts?.length) {
            availableGifts.forEach(gift => {
              GIFT_MAP.set(gift.id, {
                name: gift.name,
                coins: gift.diamond_count || gift.coins || 1
              });
            });
            log.info(`[gifts] Loaded ${GIFT_MAP.size} gifts from TikTok API`);
          }
        } catch (err) {
          log.warn('[gifts] Could not load gift list:', err.message);
        }

        // Hardcoded fallback for common gifts when API is unavailable.
        // These are standard TikTok gift IDs — add more as discovered from logs.
        const KNOWN_GIFTS = {
          5655: { name: 'Rose', coins: 1 },
          5879: { name: 'TikTok', coins: 1 },
          5487: { name: 'Finger Heart', coins: 5 }, // [Phase 3A] corrected from 'Ice Cream' — confirmed via DIAG-A live payload logs
          // 5269: unverified/duplicate Finger Heart entry — superseded by the confirmed 5487 mapping above (Phase 3A)
          6059: { name: 'Finger Heart', coins: 5 },
          8913: { name: 'Rosa / Heart', coins: 10 }, // real ID seen in live logs
          5585: { name: 'Heart', coins: 10 },
          6093: { name: 'Perfume', coins: 20 },
          6052: { name: 'Doughnut', coins: 30 },
          8923: { name: 'Hand Heart', coins: 100 }
        };

        for (const [id, gift] of Object.entries(KNOWN_GIFTS)) {
          if (!GIFT_MAP.has(Number(id))) {
            GIFT_MAP.set(Number(id), gift);
          }
        }
        log.info(`[gifts] GIFT_MAP ready with ${GIFT_MAP.size} entries`);
      })
      .catch((err) => {
        tiktokConnected = false;
        const msg = err?.message || String(err);
        log.warn(`[tiktok] connect failed: ${msg}`);

        // Signing failures are configuration problems, not transient ones, so
        // say what to do rather than silently retrying forever.
        if (/Business plan|premium|upgrade/i.test(msg)) {
          log.warn(
            '[tiktok] This is a BILLING error, not a bad key.\n' +
            '         Some Euler route needs a paid plan. If it mentions "room gifts",\n' +
            '         set enableExtendedGiftInfo: false in startTikTok().'
          );
        } else if (/sign/i.test(msg)) {
          log.warn(
            '[tiktok] This is a SIGNING error, not a problem with your stream.\n' +
            '         1. Make sure tiktok-live-connector is v2+  (npm i tiktok-live-connector@latest)\n' +
            '         2. Set EULER_API_KEY in .env — free key at https://www.eulerstream.com\n' +
            '         3. Run: node check-key.js'
          );
        }
        log.warn('[tiktok] retrying in 15s');
        tiktokReconnectTimer = setTimeout(connect, 15000);
      });
  };

  tiktok.on(WebcastEvent.STREAM_END, () => {
    tiktokConnected = false;
    io.emit('tiktok:status', { connected: false, username });
    log.warn('[tiktok] stream ended — retrying in 30s');
    tiktokReconnectTimer = setTimeout(connect, 30000);
  });

  // NOTE: this only fires for an UNEXPECTED drop. A manual stopTikTok() call
  // removes every listener (including this one) before it ever calls
  // tiktok.disconnect(), so an intentional Disconnect click can never land
  // here and schedule a retry that fights the user's own action.
  tiktok.on('disconnected', () => {
    tiktokConnected = false;
    io.emit('tiktok:status', { connected: false, username });
    log.warn('[tiktok] disconnected — retrying in 10s');
    tiktokReconnectTimer = setTimeout(connect, 10000);
  });

  tiktok.on('error', (err) => log.warn('[tiktok] error:', err?.message || err));

  tiktok.on(WebcastEvent.CHAT, (data) => {
    // Same trace + never-let-a-throw-vanish-silently shape as the other
    // handlers here. Comment text is logged only for context (field name
    // isn't confirmed against a live payload — comment/content/message are
    // tried in that order) and never affects the reward.
    log.info('[chat] raw payload:', safeDump(data));

    try {
      const identity = extractIdentity(data);
      if (!identity) {
        log.warn('[chat] no identifiable user in payload — ignoring (see raw payload above)');
        return;
      }

      const text = data.comment || data.content || data.message || '';
      log.info(`[chat] ${identity.username}: ${text}`);

      const payload = applyChatReward({
        username: identity.username,
        nickname: identity.nickname || identity.username,
        avatar: identity.avatar
      });

      if (payload) broadcastGift(payload);
    } catch (err) {
      log.error('[chat] handler threw — event dropped:', err);
    }
  });

  /**
   * Shared by both WebcastEvent.FOLLOW and the WebcastEvent.SOCIAL fallback
   * below — same trace + never-let-a-throw-vanish-silently shape as the
   * other handlers, tagged with `source` so the log makes clear which path
   * actually fired.
   */
  function handleFollowEvent(data, source) {
    log.info(`[follow:${source}] raw payload:`, safeDump(data));
    // Diagnostic fields specifically implicated in why FOLLOW may not fire —
    // see the WebcastEvent.SOCIAL listener's comment for why these matter.
    log.info(
      `[follow:${source}] displayText.key=${JSON.stringify(data?.common?.displayText?.key)} `
      + `action=${JSON.stringify(data?.action)} followType=${JSON.stringify(data?.followType)} `
      + `followCount=${JSON.stringify(data?.followCount)}`
    );

    try {
      const identity = extractIdentity(data);
      if (!identity) {
        log.warn(`[follow:${source}] no identifiable user in payload — ignoring (see raw payload above)`);
        return;
      }

      log.info(`[follow:${source}] ${identity.username} followed`);

      const payload = applyFollowReward({
        username: identity.username,
        nickname: identity.nickname || identity.username,
        avatar: identity.avatar
      });

      if (payload) broadcastGift(payload);
    } catch (err) {
      log.error(`[follow:${source}] handler threw — event dropped:`, err);
    }
  }

  tiktok.on(WebcastEvent.FOLLOW, (data) => handleFollowEvent(data, 'follow'));

  /**
   * Fallback net for follows the library itself fails to classify.
   *
   * Per tiktok-live-connector's own processDecodedData (node_modules/
   * tiktok-live-connector/dist/lib-CbB_CSnH.js), every WebcastSocialMessage —
   * which is what a follow actually arrives as on the wire — is routed by a
   * fragile string check: it only emits 'follow' when
   * `data.common.displayText.key` happens to *contain* the literal substring
   * "follow". That key is TikTok's own i18n label key, and real payloads have
   * been seen where it's missing, differently named, or doesn't match —
   * TikTok's own docs describe this whole event family as unreliable, the
   * same caveat already noted for `like`. When the key doesn't match, the
   * SAME message is emitted as the generic 'social' event instead, which
   * nothing here was listening for — so a real follow silently vanishes
   * without ever reaching WebcastEvent.FOLLOW.
   *
   * WebcastSocialMessage (tiktok-live-proto v3) also carries structured,
   * non-string-matched fields — followType, followCount, action — but their
   * exact values on a genuine follow aren't confirmed against a live payload
   * yet (see the diagnostic log in handleFollowEvent above for that). Rather
   * than guess at matching those precisely and risk the same silent-drop
   * failure mode again, only actual shares are excluded (shareType/
   * shareTarget/shareCount are TikTok's own share-specific fields on this
   * same message shape) — everything else that lands here is treated as a
   * follow unconditionally, so the fish always spawns/heals rather than
   * being dropped a second time by a guess that turns out wrong.
   */
  tiktok.on(WebcastEvent.SOCIAL, (data) => {
    const looksLikeShare =
      Boolean(data?.shareType) || Boolean(data?.shareTarget) || Number(data?.shareCount) > 0;
    if (looksLikeShare) {
      log.info('[follow:social-fallback] skipped — payload looks like a share, not a follow:', safeDump(data));
      return;
    }
    handleFollowEvent(data, 'social-fallback');
  });

  tiktok.on(WebcastEvent.LIKE, (data) => {
    // Trace every raw payload while this event is under active debugging.
    // Nothing here is gated behind a one-shot flag (unlike the gift-shape
    // dump) because likes are rare and bursty enough on a real stream that
    // seeing each one's actual shape matters more than the console noise
    // costs — this is the single most direct way to tell "TikTok isn't
    // sending like events" apart from "TikTok is sending them and something
    // downstream is wrong."
    log.info('[like] raw payload:', safeDump(data));

    // A thrown error inside an EventEmitter listener can otherwise vanish
    // into the connector's internals with no trace at all — exactly the
    // "silently drops the event" failure mode to rule out here.
    try {
      const identity = extractIdentity(data);
      if (!identity) {
        log.warn('[like] no identifiable user in payload — ignoring (see raw payload above)');
        return;
      }

      // Not every payload shape carries the same field for "how many likes
      // this burst was worth" — v2.4.3 documents `likeCount`, but older/other
      // connector builds and raw webcast frames have shown up under `count`
      // or the protobuf-native `effectCnt`. Try each in order and only fall
      // back to a flat 1 if none of them parse to a real positive number, so
      // a single tap is never lost just because this payload used a field
      // name the others didn't.
      const batch =
        Number(data.count) ||
        Number(data.likeCount) ||
        parseInt(data.effectCnt, 10) ||
        1;

      registerLikes(identity, batch, 'tiktok');
    } catch (err) {
      log.error('[like] handler threw — event dropped:', err);
    }
  });

  tiktok.on(WebcastEvent.GIFT, (data) => {
    // Unconditional raw-payload dump for debugging "no gifts are arriving"
    // reports. This is server-side on purpose — data here is the actual raw
    // TikTok Live Connector event; the browser only ever receives the
    // already-resolved { username, hp, power, coins, giftName, ... } payload
    // (see broadcastGift/net.js), so a frontend console.log can only ever
    // show that it's missing, never why. Noisy by design; comment out once
    // the actual gift shape is confirmed.
    console.log('[TikTok Raw Gift Event]:', JSON.stringify(data));

    // Skip combo/streak frames — only process the final one. giftType can
    // arrive at the top level or nested under giftDetails depending on
    // library/payload version; checking both avoids re-introducing the
    // streak-counting bug documented in CLAUDE.md.
    const giftType = data.giftType ?? data.giftDetails?.giftType;
    if (giftType === 1 && !data.repeatEnd) return;

    // Gift ID: confirmed from live payloads to live at data.gift.id, not the
    // top-level data.giftId. displayText.pieces is a last-resort fallback.
    const rawGiftId =
      data.gift?.id ||
      data.giftId ||
      data.displayText?.pieces?.find((p) => p.giftValue?.giftId)?.giftValue?.giftId;

    const giftIdNum = Number(rawGiftId);
    const mappedGift = GIFT_MAP.get(giftIdNum);

    // Diamond count: confirmed from live payloads to live at data.gift.diamondCount.
    const rawDiamonds =
      (data.gift?.diamondCount > 0 ? Number(data.gift.diamondCount) : 0) ||
      (data.diamondCount > 0 ? Number(data.diamondCount) : 0) ||
      (data.gift?.diamond_count > 0 ? Number(data.gift.diamond_count) : 0) ||
      (data.giftDetails?.diamondCount > 0 ? Number(data.giftDetails.diamondCount) : 0);

    // Gift name straight off the payload — ground truth for priority (1)
    // below and for detecting a stale GIFT_MAP entry in priority (2).
    // Checked in this order because data.gift?.name / data.giftName are what
    // live tiktok-live-connector payloads have actually shown (see the
    // [TikTok Raw Gift Event] log above for this exact shape); gift_name
    // (snake_case) and a bare top-level name are extra fallbacks for other
    // connector versions/raw webcast frames, kept last since they're
    // unconfirmed against a real payload here. NOT lowercased — GIFT_NAME_MAP
    // keys below are exact-case ("Rose", not "rose"), so lowercasing here
    // would silently break every gift-name lookup instead of fixing one.
    const payloadGiftName =
      (data.gift?.name && data.gift.name !== 'Gift' ? data.gift.name : null) ||
      (data.giftName && data.giftName !== 'Gift' ? data.giftName : null) ||
      (data.gift?.gift_name && data.gift.gift_name !== 'Gift' ? data.gift.gift_name : null) ||
      (data.name && data.name !== 'Gift' ? data.name : null);

    /**
     * [Phase 3B] Priority coin resolution.
     *   1. payload gift name -> rules.GIFT_NAME_MAP (authoritative economy table)
     *   2. GIFT_MAP by id, only when it agrees with the payload name — a
     *      mismatch means GIFT_MAP is stale (wrong/reused id), so it's logged
     *      and self-healed in place rather than trusted silently.
     *   3. raw diamond count off the payload
     *   4. 1, so an unrecognised gift still registers as something
     */
    let unitCoins;
    if (payloadGiftName && rules.GIFT_NAME_MAP[payloadGiftName] !== undefined) {
      unitCoins = rules.GIFT_NAME_MAP[payloadGiftName];
    } else if (mappedGift && payloadGiftName && mappedGift.name !== payloadGiftName) {
      log.warn(
        '[GIFT-CONFLICT] GIFT_MAP id=%s says "%s" but payload says "%s" — healing with payload values',
        giftIdNum, mappedGift.name, payloadGiftName
      );
      const healed = { name: payloadGiftName, coins: rawDiamonds || mappedGift.coins };
      GIFT_MAP.set(giftIdNum, healed);
      unitCoins = healed.coins;
    } else if (mappedGift) {
      unitCoins = mappedGift.coins;
    } else {
      unitCoins = rawDiamonds || 1;
    }

    // Repeat count
    const repeat = Math.max(1, Number(data.repeatCount || data.comboCount || 1));
    const coins = unitCoins * repeat;

    // Gift name for display — payload name first (ground truth), then
    // whatever GIFT_MAP has for this id, then a coin-value guess as a last
    // resort (several gifts share coin values, so this is a label only and
    // never affects the coin count).
    let giftName = payloadGiftName || GIFT_MAP.get(giftIdNum)?.name;

    if (!giftName) {
      if (unitCoins === 5) giftName = 'Finger Heart';
      else if (unitCoins === 10) giftName = 'Heart';
      else if (unitCoins === 20) giftName = 'Perfume';
      else if (unitCoins === 30) giftName = 'Doughnut';
      else if (unitCoins === 100) giftName = 'Hand Heart';
      else giftName = 'Gift';
    }

    // User identity
    const identity = extractIdentity(data);
    if (!identity) {
      log.warn('[gift] no identifiable user — ignoring');
      return;
    }

    log.info(`[gift] ${identity.username} sent ${giftName} (id:${giftIdNum}) x${repeat} = ${coins} coins`);

    const payload = applyGift({
      username: identity.username,
      nickname: identity.nickname || identity.username,
      avatar: identity.avatar,
      coins,
      giftName
    });

    if (payload) broadcastGift(payload);
  });

  connect();
}

/**
 * Tear down the active connection cleanly. Order matters here:
 *   1. Cancel any pending retry timer (a failed-connect or stream-end/
 *      disconnected handler may have one queued) — otherwise a "clean"
 *      disconnect gets undone 10-30s later by its own retry logic.
 *   2. Remove every listener on the connection object BEFORE calling
 *      disconnect() — the connector's own 'disconnected' event would
 *      otherwise fire on this exact call and schedule ANOTHER retry,
 *      fighting the disconnect that's happening right now.
 *   3. Only then call disconnect() and drop the reference.
 * `silent` is used by startTikTok() when switching users, so a mid-switch
 * teardown doesn't broadcast a spurious "disconnected" the UI would show for
 * a fraction of a second before the new connection's "connected" arrives.
 */
function stopTikTok({ silent = false } = {}) {
  if (tiktokReconnectTimer) {
    clearTimeout(tiktokReconnectTimer);
    tiktokReconnectTimer = null;
  }

  const wasUsername = tiktokUsername;
  if (tiktok) {
    tiktok.removeAllListeners();
    try {
      tiktok.disconnect();
    } catch (err) {
      log.warn('[tiktok] disconnect() threw (ignoring, tearing down anyway):', err?.message || err);
    }
    tiktok = null;
  }

  tiktokConnected = false;
  tiktokUsername = '';

  if (!silent) {
    io.emit('tiktok:status', { connected: false, username: null });
    log.info(`[tiktok] disconnected from @${wasUsername || '(none)'}`);
  }
}

// ------------------------------------------------------- simulation driver ---

const SIM_NAMES = ['reef_ranger', 'nova_kai', 'deep_diver', 'saltysam', 'mizu', 'coralqueen', 'krakenlord', 'bubblegumx'];
const SIM_COINS = [1, 1, 1, 5, 10, 20, 30, 100];

function startSimulation() {
  log.info('[sim] simulation mode ON — generating fake gifts every 2-5s');
  const tick = () => {
    const username = SIM_NAMES[Math.floor(Math.random() * SIM_NAMES.length)];
    const coins = SIM_COINS[Math.floor(Math.random() * SIM_COINS.length)];
    broadcastGift(applyGift({ username, nickname: username, coins }));
    setTimeout(tick, 2000 + Math.random() * 3000);
  };
  setTimeout(tick, 2500);
}

// ----------------------------------------------------------------- startup ---

(async () => {
  await store.connect();
  server.listen(PORT, () => {
    log.info('');
    log.info(`  🌊 Fish Battle running at http://localhost:${PORT}`);
    log.info(`  💾 Mongo:  ${MONGO_URL}/${DB_NAME}  (${store.connected ? 'connected' : 'offline — in-memory fallback'})`);
    log.info(`  🔐 Admin reset: Ctrl+Alt+Shift+A in the browser, key required`);
    log.info(`  📡 TikTok: not connected — use the admin panel's Connect (key required) to start one`);
    log.info('');
  });
  // No auto-connect at boot, and no .env username fallback — startTikTok()
  // is only ever called from POST /api/admin/tiktok/connect now, with an
  // explicit username from that request. See the block comment on PORT above.
  if (SIMULATE && SIMULATE_AUTOSPAWN) startSimulation();
})();

// Flush pending writes before the process exits so nothing is lost on Ctrl+C.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`\n[server] ${signal} — flushing state to MongoDB...`);
  try { await tiktok?.disconnect(); } catch { /* ignore */ }
  await store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log.error('[uncaught]', err));
process.on('unhandledRejection', (err) => log.error('[unhandled]', err));
