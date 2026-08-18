/**
 * login.js — auth gate for Fish Battle.
 *
 * Talks to the standalone auth service (src/server.js, default port 5000),
 * a separate process from the game server (server/server.js, port 3000) that
 * happens to also be serving this very page as a static file.
 *
 * The auth base URL and token storage are both delegated — see
 * authConfig.js (where the auth service lives) and tokenStore.js (where the
 * JWT is kept: OS-encrypted storage inside Electron, localStorage in a bare
 * browser tab).
 */

import { getAuthBase } from './authConfig.js';
import { getToken, setToken, clearToken, setRefreshToken, clearRefreshToken } from './tokenStore.js';

const el = {
  card: document.getElementById('auth-card'),
  tabLogin: document.getElementById('tab-login'),
  tabRegister: document.getElementById('tab-register'),
  error: document.getElementById('auth-error'),
  notice: document.getElementById('auth-notice'),
  formLogin: document.getElementById('form-login'),
  formRegister: document.getElementById('form-register'),
  loginEmail: document.getElementById('login-email'),
  loginPassword: document.getElementById('login-password'),
  loginSubmit: document.getElementById('login-submit'),
  registerEmail: document.getElementById('register-email'),
  registerPassword: document.getElementById('register-password'),
  registerSubmit: document.getElementById('register-submit'),
  blocked: document.getElementById('blocked-screen'),
  blockedEmail: document.getElementById('blocked-email'),
  blockedStatus: document.getElementById('blocked-status'),
  whatsappLink: document.getElementById('whatsapp-link'),
  recheckBtn: document.getElementById('recheck-btn'),
  logoutBtn: document.getElementById('logout-btn')
};

// ------------------------------------------------------------------ state --

function isSubscriptionActive(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'premium' || !user.subscriptionExpiresAt) return false;
  return new Date(user.subscriptionExpiresAt).getTime() > Date.now();
}

// -------------------------------------------------------------------- ui ---

function showError(message) {
  el.error.textContent = message || '';
  el.notice.textContent = '';
}
function showNotice(message) {
  el.notice.textContent = message || '';
  el.error.textContent = '';
}

/**
 * The resting default: login/register form visible, blocked screen (and the
 * sign-out button living inside it) hidden. This is what initial page load
 * always shows — see resetToLoginScreen() below.
 */
function showAuthCard() {
  el.card.hidden = false;
  el.blocked.hidden = true;
}

/**
 * Builds a wa.me link pre-filled with the subscription-request template,
 * reusing whatever number is already in the HTML (el.whatsappLink.href)
 * rather than duplicating the placeholder number here — there is exactly one
 * place to swap in the real number.
 */
function buildWhatsAppLink(email) {
  const base = el.whatsappLink.href.split('?')[0];
  const message = `Salam, mən Fish Battle tətbiqində abunəlik almaq istəyirəm. Hesab emailim: ${email || ''}`;
  return `${base}?text=${encodeURIComponent(message)}`;
}

/** Only ever reached via an active login or a re-check — never from a bare page load. */
function showBlocked(user) {
  el.card.hidden = true;
  el.blocked.hidden = false;
  el.blockedEmail.textContent = user && user.email ? `Hesab: ${user.email}` : '';
  el.blockedStatus.textContent = '';
  if (el.whatsappLink) el.whatsappLink.href = buildWhatsAppLink(user && user.email);
}

function switchTab(tab) {
  const loginActive = tab === 'login';
  el.tabLogin.classList.toggle('is-active', loginActive);
  el.tabRegister.classList.toggle('is-active', !loginActive);
  el.tabLogin.setAttribute('aria-selected', String(loginActive));
  el.tabRegister.setAttribute('aria-selected', String(!loginActive));
  el.formLogin.hidden = !loginActive;
  el.formRegister.hidden = loginActive;
  showError('');
  showNotice('');
}

el.tabLogin.addEventListener('click', () => switchTab('login'));
el.tabRegister.addEventListener('click', () => switchTab('register'));

// --------------------------------------------------------------- network ---

async function apiRequest(path, options = {}) {
  const authBase = await getAuthBase();
  const res = await fetch(`${authBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response (e.g. the auth service isn't running) — data stays null.
  }

  if (!res.ok || !data || !data.success) {
    const message = (data && data.error) || `Request failed (${res.status}).`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------ session flow --

/** Long enough to actually read the toast before the page navigates away. */
const REDIRECT_DELAY_MS = 1200;

/** GET /api/auth/me with the stored token. Throws (with .status) on failure. */
async function fetchCurrentUser() {
  const token = await getToken();
  if (!token) {
    const err = new Error('No stored session.');
    err.status = 401;
    throw err;
  }
  const data = await apiRequest('/me', { headers: { Authorization: `Bearer ${token}` } });
  return data.user;
}

/** After a successful login, route to the game or the block screen. */
function routeUser(user) {
  if (isSubscriptionActive(user)) {
    window.location.href = '/index.html';
    return;
  }
  showBlocked(user);
}

/**
 * Fallback to a clean manual-login slate: any existing token is dropped,
 * the login tab is shown. Used whenever auto-login (boot(), below) doesn't
 * apply — no token, an invalid/expired one, or an inactive subscription.
 * The blocked screen is only ever reached via an explicit login
 * (routeUser(), below) or a re-check from it (recheckStatus()), never from
 * this reset path.
 */
async function resetToLoginScreen() {
  await clearToken();
  showAuthCard();
  switchTab('login');
  el.blockedStatus.textContent = '';
}

/**
 * "Yenidən Yoxla" button. Stays on the blocked screen the entire time,
 * updating its own status line in place, and only navigates away once an
 * active subscription is confirmed.
 */
async function recheckStatus() {
  el.recheckBtn.disabled = true;
  el.blockedStatus.textContent = 'Yoxlanılır…';

  try {
    const user = await fetchCurrentUser();

    if (isSubscriptionActive(user)) {
      el.blockedStatus.textContent = 'Abonəliyiniz aktivləşdirildi!';
      setTimeout(() => { window.location.href = '/index.html'; }, REDIRECT_DELAY_MS);
      return;
    }

    showBlocked(user); // refreshes the email + WhatsApp template in case anything changed
    el.blockedStatus.textContent = 'Abonəlik hələ aktiv edilməyib. Lütfən ödəniş edib WhatsApp-dan bizə yazın.';
  } catch (err) {
    if (err.status === 401) {
      await clearToken();
      showAuthCard();
      switchTab('login');
      showNotice('Your session expired — please sign in again.');
      return;
    }
    el.blockedStatus.textContent = `Could not check status: ${err.message}`;
  } finally {
    el.recheckBtn.disabled = false;
  }
}

// -------------------------------------------------------------- handlers ---

el.formLogin.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  showNotice('');
  el.loginSubmit.disabled = true;
  el.loginSubmit.textContent = 'Signing in…';

  try {
    const data = await apiRequest('/login', {
      method: 'POST',
      body: JSON.stringify({
        email: el.loginEmail.value.trim(),
        password: el.loginPassword.value
      })
    });
    await setToken(data.token);
    if (data.refreshToken) {
      await setRefreshToken(data.refreshToken);
    }
    routeUser(data.user);
  } catch (err) {
    showError(err.message);
  } finally {
    el.loginSubmit.disabled = false;
    el.loginSubmit.textContent = 'Sign In';
  }
});

el.formRegister.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  showNotice('');
  el.registerSubmit.disabled = true;
  el.registerSubmit.textContent = 'Creating…';

  try {
    const email = el.registerEmail.value.trim();
    await apiRequest('/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: el.registerPassword.value })
    });
    // Registration doesn't return a token — send them to Login to sign in
    // with the account they just created.
    switchTab('login');
    el.loginEmail.value = email;
    showNotice('Account created — sign in to continue.');
  } catch (err) {
    showError(err.message);
  } finally {
    el.registerSubmit.disabled = false;
    el.registerSubmit.textContent = 'Create Account';
  }
});

el.recheckBtn.addEventListener('click', () => recheckStatus());

el.logoutBtn.addEventListener('click', async () => {
  await clearToken();
  showAuthCard();
  switchTab('login');
});

// ---------------------------------------------------------------- boot -----

/**
 * Try a silent auto-login before showing anything. Both overlays are hidden
 * via JS first (not just relying on the HTML/CSS defaults) so a check that
 * ends in a redirect never flashes the login form on the way out. Any
 * failure — no token, an expired one, a /me error, an inactive subscription
 * — falls through to the normal manual-login screen; auto-login only ever
 * skips the form on a fully valid, active session, and it never shows the
 * blocked screen itself (see resetToLoginScreen()'s comment above).
 */
async function boot() {
  el.card.hidden = true;
  el.blocked.hidden = true;

  const token = await getToken();
  if (token) {
    try {
      const user = await fetchCurrentUser();
      if (isSubscriptionActive(user)) {
        window.location.href = '/index.html';
        return;
      }
    } catch {
      // No valid session — fall through to the manual login screen below.
    }
  }

  await resetToLoginScreen();

  // authGuard.js's heartbeat (index.html, every 60s) redirects here with
  // ?reason=expired the instant it kicks a session — subscription expired,
  // token invalid, or the auth service unreachable. Shown after
  // resetToLoginScreen() on purpose: switchTab('login') inside it clears
  // both message areas, so setting this any earlier would just get wiped.
  if (new URLSearchParams(window.location.search).get('reason') === 'expired') {
    showError('Sessiyanız bitdi — abunəliyiniz aktiv deyil. Yenidən daxil olun.');
  }
}

boot();
