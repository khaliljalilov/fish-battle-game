/**
 * authMiddleware.js — verifies a bearer JWT and attaches its claims to
 * req.user. Only the claims (id, email, role at token-issue time) — routes
 * that need current, authoritative data (e.g. GET /api/auth/me) still look
 * the user up by req.user.id rather than trusting a possibly-stale role.
 */

const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, error: 'Missing or malformed Authorization header.' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
}

module.exports = requireAuth;
