/**
 * authGuard.js — the gate main.js sits behind, and the logout action.
 *
 * Talks to the standalone auth service (src/server.js, location resolved via
 * authConfig.js) — same contract public/js/login.js already relies on. Two
 * checks, cheapest first:
 *   1. Is there a token at all? No network call needed to answer that.
 *   2. Does the server still consider it valid, premium, and unexpired?
 *      This is a live DB check (GET /api/auth/me), not a decode of the
 *      token's own claims, so a subscription revoked after login is caught
 *      even though the token itself hasn't expired.
 */

import { getAuthBase } from './authConfig.js';
import { getToken, clearToken, refreshAuthToken } from './tokenStore.js';

const HEARTBEAT_INTERVAL_MS = 60_000;

let heartbeatTimer = null;

function redirectToLogin(reason) {
  window.location.href = reason ? `/login.html?reason=${reason}` : '/login.html';
}

export async function clearSession() {
  await clearToken();
}

/** Called from a logout button: drop the token and leave for the login page. */
export async function logout() {
  await clearSession();
  redirectToLogin();
}

/**
 * Wire #logout-btn as soon as the DOM is ready, independent of the game's
 * own boot sequence — Game.start() is gated behind ensureAuthorized(), which
 * can take a moment (or fail, or hang) to resolve. Sign-out must not depend
 * on that ever finishing.
 */
function wireLogoutButton() {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => { await logout(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireLogoutButton);
} else {
  // Module scripts execute after the document has already been parsed, so
  // in practice this is the branch that actually runs — the listener above
  // exists for correctness if that assumption ever stops holding.
  wireLogoutButton();
}

function isSubscriptionActive(user) {
  if (!user) return false;
  // Admins bypass the expiry check entirely — there's no subscription to
  // expire for an account that isn't paying for one.
  if (user.role === 'admin') return true;
  if (user.role !== 'premium' || !user.subscriptionExpiresAt) return false;
  return new Date(user.subscriptionExpiresAt).getTime() > Date.now();
}

/**
 * Resolves true if the game may launch. Resolves false if the caller should
 * stop where it is — a redirect to /login.html is already underway by then,
 * so there is nothing left to render.
 */
export async function ensureAuthorized() {
  const token = await getToken();
  if (!token) {
    redirectToLogin();
    return false;
  }

  try {
    const authBase = await getAuthBase();
    const res = await fetch(`${authBase}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data || !data.success || !isSubscriptionActive(data.user)) {
      if (res.status === 401) {
        const refreshed = await refreshAuthToken();
        if (refreshed) {
          return true;
        }
      }
      await clearSession();
      redirectToLogin();
      return false;
    }
    return true;
  } catch (err) {
    // Auth service unreachable — fail closed. The point of this gate is that
    // the game must not run when its status can't be confirmed; failing open
    // here would let anyone bypass the whole check just by blocking access
    // to the auth service.
    console.error('[authGuard] could not verify session:', err);
    await clearSession();
    redirectToLogin();
    return false;
  }
}

/**
 * Ends the session immediately: stops the heartbeat, drops the token, tells
 * main.js's Game to freeze (a window event, dispatched synchronously so its
 * listener runs and sets `running = false` before the redirect below takes
 * effect — otherwise the render loop would keep ticking for however long
 * navigation takes), then sends the tab to the login screen with a reason it
 * can show as a message.
 */
async function kick(reason) {
  stopAuthHeartbeat();
  const refreshed = await refreshAuthToken();
  if (!refreshed) {
    await clearSession();
  }
  window.dispatchEvent(new CustomEvent('auth:kicked'));
  redirectToLogin(reason);
}

export function stopAuthHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Re-checks /api/auth/me every 60s for as long as the tab stays open.
 * ensureAuthorized() only checks once, at boot — this is what catches a
 * subscription expiring or being revoked mid-session, so a viewer can't
 * keep playing past expiry just by never refreshing.
 *
 * Fails closed on any error, same as ensureAuthorized(): a network blip
 * against the auth service is indistinguishable from "can't confirm this
 * session is still valid", and this gate treats both as a reason to stop.
 */
export function startAuthHeartbeat() {
  stopAuthHeartbeat(); // idempotent — never let two timers stack

  heartbeatTimer = setInterval(async () => {
    const token = await getToken();
    if (!token) {
      await kick('expired');
      return;
    }

    try {
      const authBase = await getAuthBase();
      const res = await fetch(`${authBase}/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data || !data.success || !isSubscriptionActive(data.user)) {
        if (res.status === 401) {
          const refreshed = await refreshAuthToken();
          if (refreshed) return;
        }
        await kick('expired');
      }
    } catch (err) {
      console.error('[authGuard] heartbeat check failed:', err);
      await kick('expired');
    }
  }, HEARTBEAT_INTERVAL_MS);
}
