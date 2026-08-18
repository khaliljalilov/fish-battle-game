const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { register, login, me, refresh } = require('../controllers/authController');
const requireAuth = require('../middleware/authMiddleware');

const router = express.Router();

// Credential-guessing surface: register lets an attacker probe which emails
// already have accounts (see authController.js), login is a straightforward
// brute-force target. Keyed by IP, so this deliberately does NOT cover /me —
// authGuard.js polls that every 60s for as long as a tab stays open, which
// would blow through a limit this tight and log real sessions out.
function normalizeLoginKey(req) {
  const email = typeof req?.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email || ipKeyGenerator(req);
}

const authLimiter = rateLimit({
  // Limit by account email rather than raw IP so a shared Wi‑Fi / NAT doesn't
  // accidentally block every user behind the same router. This still throttles
  // brute-force attempts against the same account, while preserving usability.
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: normalizeLoginKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Try again later.' }
});

// Refresh tokens are fewer and already carry a valid token, so a tighter
// limit here doesn't hurt legitimate users but caps stolen-token reuse.
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many refresh attempts. Try again later.' }
});

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/refresh', refreshLimiter, refresh);
// Re-verifies role/subscriptionExpiresAt against the DB — used by the
// "Yenidən Yoxla" (check status) button on the subscription-blocked screen.
router.get('/me', requireAuth, me);

module.exports = router;
