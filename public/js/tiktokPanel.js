/**
 * tiktokPanel.js — TikTok Live connect/disconnect control, bottom-right.
 *
 * Standalone from main.js/net.js on purpose (no import relationship — see
 * index.html's comment on #tiktok-panel), but NOT standalone from the
 * server anymore: Connect/Disconnect here call the real, admin-key-gated
 * endpoints (POST /api/admin/tiktok/connect|disconnect in server.js), which
 * own the single server-side TikTok bridge broadcast to every viewer. This
 * used to be a simulated per-viewer "look up a creator" toggle with no
 * backend endpoint — see git history if you need that version back.
 *
 * The separate `tiktok-panel:status` CustomEvent this panel dispatches on
 * every connect/disconnect is UNRELATED to whether the real connection
 * succeeded — it drives main.js's local, per-viewer "mute gift events in my
 * own view" toggle (_initTikTokGate), which has worked this way since before
 * this panel talked to a real backend and must keep working even when no
 * real TikTok connection exists at all (test panel / SIMULATE mode rely on
 * it). Left completely alone here on purpose.
 *
 * Loaded as its own <script type="module"> in index.html, independent of
 * main.js/Game — it touches no game state and must keep working even if
 * the WebGL boot sequence in main.js fails.
 */

/**
 * Remembered locally per-browser so the admin doesn't have to retype the key
 * on every reload. This is the same key already required to authenticate
 * every request it's used with — nothing here is more sensitive by being
 * cached than it already was by existing in the input field.
 */
const ADMIN_KEY_STORAGE_KEY = 'fishBattleAdminKey';
/**
 * Last-connected username, remembered purely as an input-prefill convenience
 * (reconnecting to the same channel next stream without retyping) — it is
 * NEVER treated as proof of a live connection. Whether to actually show the
 * connected/profile UI is decided only by asking the server via
 * GET /api/tiktok/status (see checkServerStatus below), because the real
 * connection can outlive this tab's own memory of it (page refresh) or die
 * without this tab knowing (stream ended, another admin disconnected it).
 */
const TIKTOK_USERNAME_STORAGE_KEY = 'fishBattleTikTokUsername';

const el = {
  panel: document.getElementById('tiktok-panel'),
  connectRow: document.getElementById('tiktok-connect-row'),
  input: document.getElementById('tiktok-username-input'),
  adminKeyInput: document.getElementById('tiktok-admin-key-input'),
  connectBtn: document.getElementById('tiktok-connect-btn'),
  error: document.getElementById('tiktok-error'),
  profile: document.getElementById('tiktok-profile'),
  avatar: document.getElementById('tiktok-avatar'),
  name: document.getElementById('tiktok-display-name'),
  disconnectBtn: document.getElementById('tiktok-disconnect-btn')
};

function showError(message) {
  el.error.textContent = message || '';
  el.error.classList.toggle('is-visible', Boolean(message));
}

function normalizeUsername(raw) {
  return raw.trim().replace(/^@+/, '');
}

/** Deterministic placeholder avatar (ring + initial) — no network call. */
function avatarDataUri(username) {
  const initial = (username[0] || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#00fff7"/><stop offset="100%" stop-color="#ff00e6"/>` +
    `</linearGradient></defs>` +
    `<circle cx="32" cy="32" r="30" fill="#0a0a12" stroke="url(#g)" stroke-width="3"/>` +
    `<text x="32" y="41" font-family="sans-serif" font-size="26" font-weight="700" ` +
    `fill="#eafffb" text-anchor="middle">${initial}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * POST an admin-gated TikTok action. Returns the parsed JSON body on both
 * success and failure — every route here always responds with JSON (see
 * server.js), so a non-ok status still has {ok:false, error} to show.
 */
async function postAdmin(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({ ok: false, error: `Server returned ${res.status}` }));
  return { ok: res.ok && data.ok !== false, data };
}

function setLoading(loading) {
  el.connectBtn.disabled = loading;
  el.connectBtn.classList.toggle('is-loading', loading);
  el.connectBtn.textContent = loading ? 'Connecting…' : 'Connect';
  el.input.disabled = loading;
  el.adminKeyInput.disabled = loading;
}

/**
 * Tells main.js's Game whether gift events should affect the arena — a
 * LOCAL, per-viewer mute, not a report of the real connection state. See
 * the module comment above.
 */
function broadcastStatus(connected) {
  window.dispatchEvent(new CustomEvent('tiktok-panel:status', { detail: { connected } }));
}

function showProfile(username) {
  el.avatar.src = avatarDataUri(username);
  el.name.textContent = `@${username}`;
  el.connectRow.hidden = true;
  el.profile.hidden = false;
  el.panel.classList.add('is-connected');
  try {
    localStorage.setItem(TIKTOK_USERNAME_STORAGE_KEY, username);
  } catch (err) {
    console.warn('[tiktokPanel] could not remember username:', err.message);
  }
  broadcastStatus(true);
}

function resetPanel() {
  el.profile.hidden = true;
  el.connectRow.hidden = false;
  el.panel.classList.remove('is-connected');
  el.input.value = '';
  setLoading(false);
  showError('');
  try {
    localStorage.removeItem(TIKTOK_USERNAME_STORAGE_KEY);
  } catch (err) {
    console.warn('[tiktokPanel] could not clear remembered username:', err.message);
  }
  broadcastStatus(false);
}

/**
 * Ask the server what's actually connected right now — the fix for the
 * refresh bug. localStorage's remembered username only prefills the input;
 * this is what decides whether to show the connected/profile view at all.
 * Runs once on load, alongside the admin-key restore below.
 */
async function checkServerStatus() {
  try {
    const res = await fetch('/api/tiktok/status');
    const data = await res.json();
    if (data.connected && data.username) {
      showProfile(data.username);
    }
  } catch (err) {
    // Server unreachable on load — leave the panel in its default
    // disconnected state rather than guessing. No error shown; this isn't
    // a user action, just a background check.
    console.warn('[tiktokPanel] could not reach /api/tiktok/status:', err.message);
  }
}

/**
 * No client-side "disconnect first" step needed even when already
 * connected: startTikTok() on the server always tears down any existing
 * connection before starting the new one (see server.js), so a Connect
 * click while already connected to someone else is already a clean switch
 * in one request.
 */
async function handleConnect() {
  const username = normalizeUsername(el.input.value);
  const key = el.adminKeyInput.value;
  showError('');

  if (!username) {
    showError('TikTok istifadəçi adını daxil edin.');
    return;
  }
  if (!key) {
    showError('Admin key tələb olunur.');
    return;
  }

  setLoading(true);
  try {
    const { ok, data } = await postAdmin('/api/admin/tiktok/connect', { key, username });
    if (ok) {
      showProfile(data.username || username);
    } else {
      showError(data.error || 'Qoşulma alınmadı.');
    }
  } catch (err) {
    showError(`Şəbəkə xətası: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

async function handleDisconnect() {
  const key = el.adminKeyInput.value;
  if (!key) {
    showError('Admin key tələb olunur.');
    return;
  }

  el.disconnectBtn.disabled = true;
  showError('');
  try {
    const { ok, data } = await postAdmin('/api/admin/tiktok/disconnect', { key });
    if (ok) {
      resetPanel();
    } else {
      showError(data.error || 'Ayrılma alınmadı.');
    }
  } catch (err) {
    showError(`Şəbəkə xətası: ${err.message}`);
  } finally {
    el.disconnectBtn.disabled = false;
  }
}

if (el.connectBtn && el.disconnectBtn) {
  // Restore remembered inputs on load, if any — try/catch because
  // localStorage can throw in some privacy-mode/embedded-iframe contexts,
  // and a missing convenience feature shouldn't take the whole panel down.
  try {
    const remembered = localStorage.getItem(ADMIN_KEY_STORAGE_KEY);
    if (remembered) el.adminKeyInput.value = remembered;
  } catch (err) {
    console.warn('[tiktokPanel] could not read remembered admin key:', err.message);
  }
  try {
    const rememberedUsername = localStorage.getItem(TIKTOK_USERNAME_STORAGE_KEY);
    if (rememberedUsername) el.input.value = rememberedUsername;
  } catch (err) {
    console.warn('[tiktokPanel] could not read remembered username:', err.message);
  }

  // The actual refresh-bug fix: ask the server what's really connected.
  // checkServerStatus() calls showProfile() itself if the server says yes,
  // which overrides the connectRow the two restores above just populated —
  // that's correct, a live connection always wins over a remembered input.
  checkServerStatus();

  el.adminKeyInput.addEventListener('input', () => {
    try {
      if (el.adminKeyInput.value) {
        localStorage.setItem(ADMIN_KEY_STORAGE_KEY, el.adminKeyInput.value);
      } else {
        localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
      }
    } catch (err) {
      console.warn('[tiktokPanel] could not remember admin key:', err.message);
    }
  });

  el.connectBtn.addEventListener('click', handleConnect);
  el.disconnectBtn.addEventListener('click', handleDisconnect);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
  });
  el.adminKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
  });
}
