/**
 * authConfig.js — where the standalone auth service lives.
 *
 * Read from GET /api/config (served by the game server, same origin as this
 * page) instead of a hardcoded localhost:5000 literal, so the auth service
 * can move to a hosted URL without touching every file that calls it.
 */

let cached = null;

export async function getAuthBase() {
  if (cached) return cached;
  const res = await fetch('/api/config', { cache: 'no-store' });
  const data = await res.json();
  cached = data.authBase;
  return cached;
}
