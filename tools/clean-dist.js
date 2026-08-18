#!/usr/bin/env node
/**
 * tools/clean-dist.js — pre-build step for `npm run build:exe`.
 *
 * electron-builder overwrites files it recognizes but never removes stale
 * ones — a version bump leaves the old "Fish Battle Arena Setup X.exe" and
 * blockmap sitting in dist/ next to the new one. Wiping dist/ first (same
 * rmSync({recursive, force}) pattern tools/obfuscate.js uses for
 * build/obfuscated/) guarantees the directory only ever holds the artifacts
 * from the build that just ran.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

console.log('[clean-dist] removing', path.relative(ROOT, DIST_DIR));
fs.rmSync(DIST_DIR, { recursive: true, force: true });
