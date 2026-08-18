/**
 * electron/serverManager.js — spawns, health-checks, and shuts down the two
 * backend Node processes this app depends on:
 *
 *   server/server.js   (game server + Socket.IO, default port 3000)
 *   src/server.js      (auth service, default port 5000)
 *
 * Both scripts already do their own `require('dotenv').config()` and their
 * own fatal-env-var checks (see their own [fatal] console.error + exit(1)
 * calls) — this module doesn't duplicate that validation, it just captures
 * whatever they print so a startup failure is visible to the user instead
 * of silently hanging on a blank window.
 *
 * Spawned via `process.execPath` (the Electron binary itself) with
 * ELECTRON_RUN_AS_NODE=1, not a bare `node` command — that's the standard
 * trick for running a plain Node script from inside Electron WITHOUT
 * depending on a system Node.js install being on PATH. It does nothing
 * useful today (this only ever runs via `npm run desktop`, which already
 * requires Node), but it's what makes this correct once the app is later
 * packaged and handed to someone who may not have Node installed at all —
 * getting this right now avoids having to redo it in that step.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.join(__dirname, '..');

/** Keep only the last ~4KB of combined output — enough context for an error
 *  dialog without holding an unbounded log in memory for a long-running stream. */
const OUTPUT_TAIL_LIMIT = 4000;

/**
 * Spawn one backend script as a child process, tee its stdout/stderr to
 * this process's own console (prefixed, so `npm run desktop` in a terminal
 * shows which process said what) and keep a rolling tail of it for
 * diagnostics if it exits early.
 *
 * `scriptRelativePath` is always resolved against PROJECT_ROOT (correct
 * even when packaged — that resolves to inside app.asar, which Electron's
 * own binary can read/execute directly). `cwd` is NOT defaulted to
 * PROJECT_ROOT when packaged: an asar path isn't a real filesystem
 * directory, and setting a child process's OS-level cwd to one fails at
 * spawn time. The caller (main.js) is responsible for passing a real,
 * existing directory as `cwd` when app.isPackaged — see firstRunConfig.js
 * and the app.isPackaged branch in main.js.
 */
function spawnService(name, scriptRelativePath, { cwd = PROJECT_ROOT, env = {} } = {}) {
  const scriptPath = path.join(PROJECT_ROOT, scriptRelativePath);
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let tail = '';
  const capture = (buf) => {
    const text = buf.toString();
    tail = (tail + text).slice(-OUTPUT_TAIL_LIMIT);
    // eslint-disable-next-line no-console
    process.stdout.write(`[${name}] ${text}`);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  // Distinct from the process exiting on its own — this fires if the OS
  // couldn't even launch it (e.g. a bad path). waitForHealthy only listens
  // for 'exit', which isn't guaranteed to follow a failed spawn on every
  // platform, so this is what keeps that case from failing silently.
  child.on('error', (err) => {
    tail += `\n[${name}] failed to launch: ${err.message}\n`;
    console.error(`[${name}] failed to launch:`, err);
  });

  child.serviceName = name;
  child.getOutputTail = () => tail;
  return child;
}

/**
 * Poll a URL until it responds at all (any HTTP status counts — a 404 still
 * proves the process is up and listening, which is all this needs to know;
 * server/server.js's own /api/health happens to return 200, src/server.js
 * has no dedicated health route so this settles for "responds to anything")
 * or the deadline passes.
 *
 * Also races against the child exiting early: no point polling for 15s if
 * the process already died 200ms in with a missing-env-var fatal error.
 */
function waitForHealthy(url, child, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    const onExit = (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `${child.serviceName} exited early (code ${code}) before it became healthy.\n\n${child.getOutputTail()}`
      ));
    };
    child.once('exit', onExit);

    const attempt = () => {
      if (settled) return;
      const req = http.get(url, (res) => {
        res.resume(); // drain the response so the socket can close
        if (settled) return;
        settled = true;
        child.removeListener('exit', onExit);
        resolve();
      });
      req.on('error', () => {
        if (settled) return;
        if (Date.now() > deadline) {
          settled = true;
          child.removeListener('exit', onExit);
          reject(new Error(
            `Timed out waiting for ${child.serviceName} at ${url}.\n\n${child.getOutputTail()}`
          ));
          return;
        }
        setTimeout(attempt, intervalMs);
      });
      req.setTimeout(intervalMs, () => req.destroy());
    };
    attempt();
  });
}

/**
 * Kill a child process and resolve once it's actually gone (or after a
 * grace period, whichever comes first) — so shutdown doesn't leave an
 * orphaned node process behind when the app quits.
 *
 * On Windows this does NOT use child.kill(). Verified against this exact
 * spawn setup (process.execPath running server/server.js under Express +
 * Socket.IO): child.kill()'s 'exit' event fired and this function's promise
 * resolved, but the underlying node.exe process was confirmed STILL ALIVE
 * and still LISTENING on its port seconds later (netstat + Get-Process both
 * showed it running; only `Stop-Process -Force`/taskkill actually killed
 * it). This is a known class of Node-on-Windows unreliability, not
 * something specific to this app — libuv's Windows process termination and
 * its 'exit'-event bookkeeping don't always agree with what actually
 * happened at the OS level. `taskkill /pid <pid> /T /F` is the OS-native
 * tool and is what a manual kill used successfully here, so this uses it
 * directly instead of trusting child.kill()'s own signal. /T also kills any
 * child processes of the target, in case a future change makes one of
 * these scripts spawn something itself.
 */
function killService(child, { graceMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.killed) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);

    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
        // Ignore taskkill's own exit code (e.g. "process not found" if it
        // already exited on its own between the check above and here) —
        // child's own 'exit' event above (or the grace-timeout fallback
        // below) is still the actual signal this promise waits for.
      });
    } else {
      child.kill();
    }

    // Safety net: if 'exit' never fires (e.g. taskkill itself failed for a
    // reason other than "already gone"), don't hang forever — resolve
    // anyway after graceMs so app shutdown always completes. This does NOT
    // guarantee the process is actually dead in that failure case; it just
    // guarantees the app doesn't hang waiting on it.
    const timer = setTimeout(finish, graceMs);
  });
}

module.exports = { spawnService, waitForHealthy, killService };
