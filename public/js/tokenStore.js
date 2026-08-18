/**
 * tokenStore.js — where the session JWT is kept.
 *
 * Inside the packaged Electron app, window.electronAuthStore is exposed by
 * a preload script and backed by the OS keychain (safeStorage), so the
 * token never sits in localStorage where any future XSS could read it.
 * That bridge doesn't exist for a bare browser tab (this page is also
 * served as a plain static file by the game server, openable outside
 * Electron entirely) — localStorage is the fallback there, same as before.
 */

const TOKEN_KEY = 'fishBattleToken';
const REFRESH_KEY = 'fishBattleRefreshToken';

function bridge() {
  return typeof window !== 'undefined' ? window.electronAuthStore : undefined;
}

export async function getToken() {
  const b = bridge();
  return b ? b.getToken() : localStorage.getItem(TOKEN_KEY);
}

export async function getRefreshToken() {
  const b = bridge();
  return b ? b.getRefreshToken?.() : localStorage.getItem(REFRESH_KEY);
}

export async function setToken(token) {
  const b = bridge();
  if (b) return b.setToken(token);
  localStorage.setItem(TOKEN_KEY, token);
}

export async function setRefreshToken(refreshToken) {
  const b = bridge();
  if (b) return b.setRefreshToken?.(refreshToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export async function clearToken() {
  const b = bridge();
  if (b) return b.clearToken();
  localStorage.removeItem(TOKEN_KEY);
}

export async function clearRefreshToken() {
  const b = bridge();
  if (b) return b.clearRefreshToken?.();
  localStorage.removeItem(REFRESH_KEY);
}

export async function refreshAuthToken() {
  const token = await getToken();
  const refreshToken = await getRefreshToken();
  if (!token || !refreshToken) return false;

  try {
    const authBase = await getAuthBase();
    const res = await fetch(`${authBase}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: refreshToken })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success || !data.token) {
      await clearToken();
      await clearRefreshToken();
      return false;
    }
    await setToken(data.token);
    if (data.refreshToken) {
      await setRefreshToken(data.refreshToken);
    }
    return true;
  } catch {
    await clearToken();
    await clearRefreshToken();
    return false;
  }
}
