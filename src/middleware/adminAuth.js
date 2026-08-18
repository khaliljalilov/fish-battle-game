/**
 * adminAuth.js — gates every /api/admin/* route behind a shared secret key.
 *
 * Constant-time comparison, same pattern as the game server's admin-key check
 * (server/server.js keyIsValid): a naive === comparison leaks how many
 * leading characters matched through response timing, so a wrong guess can
 * be narrowed down character by character. The length check is done first,
 * with a dummy timingSafeEqual call to burn the same time a real comparison
 * would, so unequal-length inputs don't shortcut that cost either.
 */

const crypto = require('crypto');

function adminAuth(req, res, next) {
  const provided = req.get('x-admin-key');
  const expected = process.env.ADMIN_SECRET_KEY;

  if (!expected) {
    console.error('[admin] ADMIN_SECRET_KEY is not set — refusing all admin requests.');
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  if (!provided || !keyMatches(provided, expected)) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  next();
}

function keyMatches(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = adminAuth;
