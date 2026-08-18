/**
 * server.js — auth service entry point.
 *
 * Standalone from server/server.js (the game server): its own process, own
 * port, own .env (src/.env, see src/.env.example), own Mongo connection via
 * Mongoose. Run:  node src/server.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const errorHandler = require('./middleware/errorHandler');

const PORT = Number(process.env.PORT) || 5000;

if (!process.env.JWT_SECRET) {
  console.error('[fatal] JWT_SECRET is not set. Copy src/.env.example to src/.env and set one.');
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error('[fatal] MONGO_URI is not set. Copy src/.env.example to src/.env and set one.');
  process.exit(1);
}
if (!process.env.ADMIN_SECRET_KEY) {
  console.error('[fatal] ADMIN_SECRET_KEY is not set. Copy src/.env.example to src/.env and set one.');
  process.exit(1);
}

// Every packaged Fish Battle client loads its pages from its OWN locally-
// spawned game server at http://localhost:<game PORT> — that is the Origin
// header this service sees on every cross-origin call, from every install,
// on every end user's machine, not a per-install or per-user value. One
// fixed allowlist entry therefore covers every distributed install.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  console.warn('[warn] ALLOWED_ORIGINS is not set — no browser origin will be allowed to call this API.');
}

const app = express();
app.use(cors({
  origin(origin, callback) {
    // No Origin header at all = same-origin/non-browser caller (curl,
    // health checks) — allow. Otherwise the Origin must be on the allowlist.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

// No caching on auth responses. GET /api/auth/me in particular must always
// hit the DB — a cached "still premium" response would keep granting access
// after a revoke, and a cached "still free" response would keep blocking
// access after a promotion. This service has no static files (public/ is
// served by server/server.js, not here), so this only needs to cover the
// JSON routes below.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// General spam/DDoS ceiling for every route on this service. Generous
// enough to leave headroom for the /api/auth/me heartbeat (1 req/min per
// open tab, see authGuard.js) plus multiple viewers behind one shared IP;
// the tight per-route limit that actually matters for brute-forcing is on
// /register and /login specifically (see routes/authRoutes.js).
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(generalLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

// Must be registered after every route — see middleware/errorHandler.js.
app.use(errorHandler);

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[server] Auth service running on http://localhost:${PORT}`);
  });
});
