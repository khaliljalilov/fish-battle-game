#!/usr/bin/env node
/**
 * tools/obfuscate.js — build step for `npm run build:exe` (see package.json).
 *
 * Copies server/ and public/ into build/obfuscated/<same path>, running
 * every .js file through javascript-obfuscator on the way. Everything else
 * (models, textures, html, css, json) is copied byte-for-byte, untouched.
 *
 * src/ (the auth service) is deliberately NOT included — it runs as one
 * hosted process the developer controls (see electron/firstRunConfig.js's
 * AUTH_API_BASE_URL), never spawned locally by the packaged app, so
 * shipping it inside the .exe would serve no purpose.
 *
 * Deliberately does NOT touch the real server/, src/, or public/
 * directories — this project is actively developed in those folders
 * (`npm start`, `npm run desktop` both run straight from them), so
 * obfuscating in place would corrupt the working source tree. build/ is a
 * disposable staging output; electron-builder's package.json "build".files
 * config is what actually points the packaged app at THIS directory
 * instead of the real source for server/src/public specifically (see that
 * config for exactly which real folders get excluded in favor of this one).
 *
 * electron/*.js is intentionally NOT obfuscated — it's process-lifecycle
 * bootstrap code (spawning/health-checking/killing the two backend
 * services), not the game logic or API integrations this step exists to
 * protect, and it was carefully written and empirically tested against
 * real Windows process-kill behavior; obfuscating it adds risk for near-
 * zero protective value.
 */

const fs = require('fs');
const path = require('path');
const obfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'obfuscated');

/**
 * Matched against a file's BASENAME, not a fixed path list — so this also
 * catches any future .env-like file added anywhere under server/src/public,
 * not just the one known today (src/.env). These are never copied at all,
 * obfuscated or not: secrets, not code. A prior version of this script only
 * excluded matches like this from OBFUSCATION and still copied them
 * byte-for-byte into build/obfuscated — verified and fixed before this ever
 * shipped (see the build log this caught it in).
 */
function isEnvFile(basename) {
  return basename === '.env' || basename.startsWith('.env.');
}

/**
 * Deliberately moderate, not maximum. Two features are OFF everywhere on
 * purpose, not by oversight:
 *
 *   selfDefending / debugProtection: both are known to misbehave under
 *   non-interactive execution — piped/redirected stdio, no attached
 *   terminal, code loaded as a spawned child process rather than run
 *   directly. That's exactly server/server.js and src/server.js's actual
 *   runtime environment (see electron/serverManager.js, which spawns both
 *   with stdio: ['ignore', 'pipe', 'pipe']) and could turn "harder to
 *   reverse-engineer" into "randomly refuses to start."
 *
 *   disableConsoleOutput: MUST stay false. electron/serverManager.js's
 *   whole startup-failure diagnostics story (the error dialog on a failed
 *   launch, see electron/main.js explainFailure()) depends on reading each
 *   child's real console output; the client's own [CLIENT GIFT] log is
 *   also intentionally kept (see this session's earlier audit). Disabling
 *   it wouldn't break rendering, but it WOULD silently blind every
 *   diagnostic path this project already relies on.
 */
function baseOptions(target) {
  return {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.7,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.5,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.9,
    stringArrayShifting: true,
    unicodeEscapeSequence: true,
    splitStrings: true,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    target
  };
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

function processDir(relDir, target) {
  const srcDir = path.join(ROOT, relDir);
  const destDir = path.join(OUT_DIR, relDir);
  if (!fs.existsSync(srcDir)) return { files: 0, obfuscated: 0 };

  let files = 0;
  let obfuscatedCount = 0;

  walk(srcDir, (srcFile) => {
    if (isEnvFile(path.basename(srcFile))) return; // never copied, obfuscated or not — see isEnvFile()

    files++;
    const rel = path.relative(srcDir, srcFile);
    const destFile = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });

    if (srcFile.endsWith('.js')) {
      const code = fs.readFileSync(srcFile, 'utf8');
      let output;
      try {
        output = obfuscator.obfuscate(code, baseOptions(target)).getObfuscatedCode();
      } catch (err) {
        // Fail the whole build rather than silently ship a subset of
        // unobfuscated (or worse, half-broken) files — see the module
        // comment: a loud build-time failure beats a quiet runtime one.
        console.error(`\n[obfuscate] FAILED on ${path.relative(ROOT, srcFile)}:`);
        console.error(err.message);
        process.exit(1);
      }
      fs.writeFileSync(destFile, output);
      obfuscatedCount++;
    } else {
      fs.copyFileSync(srcFile, destFile);
    }
  });

  return { files, obfuscated: obfuscatedCount };
}

function main() {
  console.log('[obfuscate] cleaning', path.relative(ROOT, OUT_DIR));
  fs.rmSync(OUT_DIR, { recursive: true, force: true });

  const targets = [
    ['server', 'node'],
    ['public', 'browser']
  ];

  let totalFiles = 0;
  let totalObfuscated = 0;
  for (const [dir, target] of targets) {
    const { files, obfuscated } = processDir(dir, target);
    console.log(`[obfuscate] ${dir}/ — ${files} files copied, ${obfuscated} obfuscated (target=${target})`);
    totalFiles += files;
    totalObfuscated += obfuscated;
  }

  if (totalObfuscated === 0) {
    console.error('[obfuscate] FAILED: zero files were obfuscated — source directories missing or empty?');
    process.exit(1);
  }

  console.log(`[obfuscate] done — ${totalFiles} files total, ${totalObfuscated} obfuscated, output at ${path.relative(ROOT, OUT_DIR)}`);
}

main();
