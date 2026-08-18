/**
 * check-key.js — diagnose an Euler Stream API key without starting the game.
 *
 * Run:  node check-key.js
 *
 * "The provided API Key is invalid" has several very different causes and the
 * error message doesn't distinguish them. This checks each one in order and
 * tells you which it is:
 *
 *   1. .env not found or not loaded
 *   2. key present but malformed (quotes, spaces, newline, wrong value pasted)
 *   3. key well-formed but rejected by Euler (wrong key, revoked, not activated)
 *   4. key valid — prints your remaining quota
 *
 * It never prints your full key.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

const ok = (m) => console.log(`${GREEN}  OK${RESET}  ${m}`);
const bad = (m) => console.log(`${RED}  ✗ ${RESET}  ${m}`);
const warn = (m) => console.log(`${YELLOW}  ! ${RESET}  ${m}`);
const info = (m) => console.log(`${DIM}      ${m}${RESET}`);

async function main() {
  console.log('\n=== Euler Stream API key check ===\n');

  // --- 1. Is there a .env at all? -----------------------------------------
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    bad('No .env file found in this folder.');
    info(`Looked in: ${envPath}`);
    info('Fix: copy .env.example .env    then edit it');
    return;
  }
  ok(`.env found at ${envPath}`);

  // --- 2. Is the key present and well-formed? ------------------------------
  const raw = process.env.EULER_API_KEY;

  if (raw === undefined) {
    bad('EULER_API_KEY is not present in .env at all.');
    info('Add a line:  EULER_API_KEY=your_key_here');
    return;
  }

  if (raw.trim() === '') {
    bad('EULER_API_KEY exists but is empty.');
    info('Get a free key at https://www.eulerstream.com then paste it after the =');
    return;
  }

  // The most common paste mistakes, each of which produces the exact same
  // "invalid key" error from the server.
  const problems = [];
  if (raw !== raw.trim()) problems.push('has leading or trailing whitespace');
  if (/^["']|["']$/.test(raw.trim())) problems.push('is wrapped in quotes — remove them, .env needs no quotes');
  if (raw.includes(' ')) problems.push('contains a space');
  if (/EULER_API_KEY/i.test(raw)) problems.push('contains "EULER_API_KEY" — you pasted the whole line, not just the value');
  if (raw.includes('\n') || raw.includes('\r')) problems.push('contains a line break');

  const key = raw.trim().replace(/^["']|["']$/g, '');

  if (problems.length) {
    bad('EULER_API_KEY looks malformed:');
    for (const p of problems) info('- ' + p);
    info('');
    info('The line should look exactly like this, no quotes, no spaces:');
    info('EULER_API_KEY=abc123def456...');
    console.log('');
  }

  info(`key length: ${key.length} chars`);
  info(`starts: ${key.slice(0, 6)}…  ends: …${key.slice(-4)}`);

  if (key.length < 20) {
    warn('That key looks short. Euler keys are long — did you paste your account ID by mistake?');
    info('In the dashboard, use the value under "API Keys", not the account/user ID.');
  }

  // --- 3. Does Euler accept it? -------------------------------------------
  let TikTokLiveConnection;
  try {
    ({ TikTokLiveConnection } = require('tiktok-live-connector'));
  } catch {
    bad('tiktok-live-connector is not installed. Run: npm install');
    return;
  }

  if (!TikTokLiveConnection) {
    bad('Your tiktok-live-connector is v1 (too old).');
    info('Run: npm i tiktok-live-connector@latest');
    return;
  }

  const version = require('tiktok-live-connector/package.json').version;
  if (Number(version.split('.')[0]) < 2) {
    bad(`tiktok-live-connector is v${version} — needs v2 or newer.`);
    info('Run: npm i tiktok-live-connector@latest');
    return;
  }
  ok(`tiktok-live-connector v${version}`);

  console.log('\n  Asking Euler Stream to validate the key…\n');

  try {
    const connection = new TikTokLiveConnection('placeholder', { signApiKey: key });

    // Note: this lives on `accounts`, not `webcast`. Several docs pages say
    // webcast, and that path simply does not exist in v2.4.x.
    const api = connection.apiClient;
    if (!api?.accounts?.getRateLimits) {
      bad('This library version has no accounts.getRateLimits endpoint.');
      info('Skipping the direct key test — try running the game instead.');
      return;
    }

    const response = await api.accounts.getRateLimits();
    const data = response?.data;

    // A 2xx alone is not proof. Corporate proxies, captive portals and egress
    // filters all return 200 with a body that is not Euler's JSON, and treating
    // that as success would send you hunting for a bug that isn't there.
    if (typeof data === 'string' || data === null || data === undefined) {
      warn('Got a reply, but it was not valid JSON from Euler Stream.');
      info(String(data).slice(0, 200));
      info('');
      info('Something between you and Euler is intercepting the request —');
      info('a proxy, VPN, firewall or DNS filter. The key itself was not tested.');
      return;
    }

    ok('Euler Stream ACCEPTED your key.');
    console.log('');
    console.log('  Your current quota:');
    console.log('  ' + JSON.stringify(data, null, 2).split('\n').join('\n  '));
    console.log('');
    info('The key is fine. If the game still fails to connect, the problem is');
    info('elsewhere — check that TIKTOK_USERNAME is a handle that is LIVE right now.');
  } catch (err) {
    const msg = err?.response?.data?.message || err?.message || String(err);
    const status = err?.response?.status;

    bad(`Euler Stream REJECTED the key${status ? ` (HTTP ${status})` : ''}:`);
    info(msg);
    console.log('');

    if (status === 429 || /too many requests|quota exceeded|rate limit exceeded/i.test(msg)) {
      console.log('  You are over your daily quota. The free tier is 2,500 requests/day.');
      console.log('  Wait for the reset, or upgrade at https://www.eulerstream.com/pricing');
    } else if (/is not a function|undefined/i.test(msg)) {
      warn('That is a library-shape error, not a key problem.');
      info('Your key was never actually sent. Try running the game directly:  npm start');
    } else if (/invalid|unauthor|forbidden/i.test(msg) || status === 401 || status === 403) {
      console.log('  Most likely one of these:');
      console.log('');
      console.log('  1. Wrong value copied. In the Euler dashboard the API key is under');
      console.log('     "API Keys". Do not use the account ID or a JWT.');
      console.log('  2. The key was regenerated — an old key stops working immediately.');
      console.log('  3. Email not verified on the Euler account.');
      console.log('  4. You are editing a different .env than the one the server loads.');
      console.log(`     This script read: ${envPath}`);
    } else {
      console.log('  Unrecognised error. Check https://www.eulerstream.com/docs');
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error('\nUnexpected failure:', e?.message || e);
  process.exit(1);
});
