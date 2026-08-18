#!/usr/bin/env node
/**
 * verify.js — catch the crashes that `node --check` cannot.
 *
 * Every runtime crash this project has shipped passed a syntax check first: a
 * method deleted by a bad edit, a field read but never assigned, a THREE symbol
 * that does not exist in r160, a DOM id referenced in JS but missing from the
 * HTML, a config key renamed on one side only. All of those parse perfectly and
 * then throw on the first frame.
 *
 * This is a static analyser, not a test suite. It cannot tell you whether the
 * game looks right — nothing here can. It tells you whether the code can run.
 *
 *   node tools/verify.js
 *
 * Exit code 0 = clean, 1 = problems found.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'public', 'js');
const SERVER_DIR = path.join(ROOT, 'server');

let failures = 0;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function pass(label) {
  console.log(`  ${green('OK')}   ${label}`);
}
function fail(label, details) {
  failures++;
  console.log(`  ${red('FAIL')} ${label}`);
  for (const d of [].concat(details)) console.log(dim(`         ${d}`));
}

function readDir(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js')) out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return out;
}

/** Every .html/.css file under public/, recursively — not just index.html /
 * style.css. login.html + css/login.css have their own ids/classes that
 * intentionally don't exist on the main page; unioning avoids false
 * positives from public/js/*.js files that belong to a different page. */
function readTextRecursive(dir, ext) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out += readTextRecursive(full, ext);
    else if (entry.name.endsWith(ext)) out += fs.readFileSync(full, 'utf8') + '\n';
  }
  return out;
}

const client = readDir(CLIENT_DIR);
const server = readDir(SERVER_DIR);
const html = readTextRecursive(path.join(ROOT, 'public'), '.html');
const css = readTextRecursive(path.join(ROOT, 'public'), '.css');
const allClient = Object.values(client).join('\n');

console.log('\nFish Battle — static verification\n');

// ---------------------------------------------------------------- syntax ---
{
  const bad = [];
  for (const dir of [CLIENT_DIR, SERVER_DIR, ROOT]) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) continue;
      
      const src = fs.readFileSync(full, 'utf8');
      // Client-side files under public/js/ use ESM syntax (import/export)
      // and are bundled/served by the browser, not run by Node directly.
      // Skip them for the Node syntax check to avoid false failures.
      if (dir === CLIENT_DIR && (/\bimport\b/.test(src) || /\bexport\b/.test(src))) continue;
      
      try {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      } catch (err) {
        bad.push(`${path.relative(ROOT, full)}: ${String(err.stderr).split('\n')[2] || 'syntax error'}`);
      }
    }
  }
  bad.length ? fail('syntax', bad) : pass('syntax');
}

// -------------------------------------------------- methods and fields ---
/**
 * The single most valuable check here. A bad multi-line edit can delete a whole
 * method while leaving the file valid JavaScript; the game then dies on the
 * first call. This has happened three times.
 */
{
  const problems = [];
  for (const [file, src] of Object.entries({ ...client, ...server })) {
    const defs = new Set(
      [...src.matchAll(/^\s{2}(?:async\s+)?([_a-zA-Z][\w]*)\s*\(/gm)].map((m) => m[1])
    );
    for (const m of src.matchAll(/^\s{2}(?:get|set)\s+([_a-zA-Z][\w]*)/gm)) defs.add(m[1]);

    const called = new Set(
      [...src.matchAll(/this\.(_[a-zA-Z][\w]*)\s*\(/g)].map((m) => m[1])
    );
    for (const name of called) {
      if (!defs.has(name)) problems.push(`${file}: this.${name}() is called but never defined`);
    }

    const assigned = new Set(
      [...src.matchAll(/this\.([a-zA-Z_][\w]*)\s*=/g)].map((m) => m[1])
    );
    for (const d of defs) assigned.add(d);
    const read = new Set(
      [...src.matchAll(/this\.([a-zA-Z_][\w]*)\b(?!\s*\()/g)].map((m) => m[1])
    );
    for (const name of read) {
      if (!assigned.has(name)) problems.push(`${file}: this.${name} is read but never assigned`);
    }
  }
  problems.length ? fail('methods and fields', problems) : pass('methods and fields');
}

// -------------------------------------------------------- named imports ---
{
  const problems = [];
  for (const [file, src] of Object.entries(client)) {
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)'/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const target = client[m[2]];
      if (!target) {
        problems.push(`${file}: imports missing module ./${m[2]}`);
        continue;
      }
      for (const n of names) {
        const exported =
          new RegExp(`export\\s+(?:async\\s+)?(const|function|class|let)\\s+${n}\\b`).test(target) ||
          new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`).test(target);
        if (!exported) problems.push(`${file}: '${n}' is not exported by ${m[2]}`);
      }
    }
  }
  problems.length ? fail('named imports', problems) : pass('named imports');
}

// ----------------------------------------------------- cross-module calls ---
/**
 * main.js orchestrates the other modules. If it calls a method that no longer
 * exists on a collaborator, nothing complains until that line runs.
 */
{
  const problems = [];
  const members = (src) => {
    const set = new Set(
      [...src.matchAll(/^\s{2}(?:async\s+)?([_a-zA-Z][\w]*)\s*\(/gm)].map((m) => m[1])
    );
    for (const m of src.matchAll(/^\s{2}(?:get|set)\s+([_a-zA-Z][\w]*)/gm)) set.add(m[1]);
    for (const m of src.matchAll(/this\.([a-zA-Z_][\w]*)\s*=/g)) set.add(m[1]);
    return set;
  };

  const map = {
    world: 'world.js', effects: 'effects.js', ui: 'ui.js',
    director: 'camera.js', net: 'net.js', library: 'models.js', audio: 'audio.js'
  };

  const main = client['main.js'] || '';
  for (const [ref, file] of Object.entries(map)) {
    if (!client[file]) continue;
    const have = members(client[file]);
    const used = new Set(
      [...main.matchAll(new RegExp(`this\\.${ref}[?]?\\.([A-Za-z_][\\w]*)`, 'g'))].map((m) => m[1])
    );
    for (const n of used) {
      if (!have.has(n)) problems.push(`main.js calls this.${ref}.${n}() — not found in ${file}`);
    }
  }
  problems.length ? fail('cross-module calls', problems) : pass('cross-module calls');
}

// ------------------------------------------------------------ THREE API ---
{
  const buildPath = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  if (!fs.existsSync(buildPath)) {
    console.log(`  ${dim('SKIP')} THREE API (run npm install to enable)`);
  } else {
    const three = fs.readFileSync(buildPath, 'utf8');
    const exported = new Set(
      [...three.match(/export\s*\{([\s\S]*?)\};/g).join(' ').matchAll(/[A-Za-z_][\w]*/g)]
        .map((m) => m[0])
    );
    const used = new Set([...allClient.matchAll(/THREE\.([A-Za-z_][\w]*)/g)].map((m) => m[1]));
    const missing = [...used].filter((n) => !exported.has(n));
    missing.length
      ? fail('THREE API', missing.map((n) => `THREE.${n} does not exist in this three version`))
      : pass(`THREE API (${used.size} symbols)`);
  }
}

// -------------------------------------------------------------- DOM ids ---
{
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set(
    [...allClient.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  );
  const missing = [...used].filter((i) => !ids.has(i));
  missing.length
    ? fail('DOM ids', missing.map((i) => `getElementById('${i}') has no matching element`))
    : pass('DOM ids');
}

// ------------------------------------------------------------ CSS classes ---
{
  const used = new Set(
    [...allClient.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)].map((m) => m[1])
  );
  const missing = [...used].filter((c) => !css.includes('.' + c));
  missing.length
    ? fail('CSS classes', missing.map((c) => `.${c} toggled in JS but not styled`))
    : pass('CSS classes');
}

// ------------------------------------------------------------ config keys ---
/**
 * Renaming a power or a tuning group on one side only produces `undefined`
 * arithmetic, which yields NaN positions and invisible fish rather than an error.
 */
{
  const cfg = client['config.js'] || '';
  const problems = [];

  for (const group of ['ARENA', 'COMBAT', 'MOVEMENT', 'PHYSICS', 'CAMERA', 'RENDER']) {
    const block = cfg.match(new RegExp(`export const ${group} = \\{([\\s\\S]*?)\\n\\};`));
    if (!block) {
      if (new RegExp(`\\b${group}\\.`).test(allClient)) problems.push(`${group} is used but not exported`);
      continue;
    }
    const keys = new Set([...block[1].matchAll(/^\s{2}([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]));
    for (const m of allClient.matchAll(new RegExp(`\\b${group}\\.([A-Za-z_]\\w*)`, 'g'))) {
      if (!keys.has(m[1])) problems.push(`${group}.${m[1]} is used but not defined`);
    }
  }

  const powers = cfg.match(/export const POWERS = \{([\s\S]*?)\n\};/);
  if (powers) {
    for (const name of [...powers[1].matchAll(/^\s{2}([a-z]\w*):/gm)].map((m) => m[1])) {
      const sub = powers[1].match(new RegExp(`${name}:\\s*\\{([\\s\\S]*?)\\n  \\}`));
      const keys = new Set(sub ? [...sub[1].matchAll(/([A-Za-z_]\w*):/g)].map((m) => m[1]) : []);
      for (const m of allClient.matchAll(new RegExp(`POWERS\\.${name}\\.([A-Za-z_]\\w*)`, 'g'))) {
        if (keys.size && !keys.has(m[1])) problems.push(`POWERS.${name}.${m[1]} is used but not defined`);
      }
    }
  }

  problems.length ? fail('config keys', [...new Set(problems)]) : pass('config keys');
}

// -------------------------------------------------- server/client parity ---
/**
 * The client mirrors the level bands so it can render without a round trip. If
 * the two drift apart, evolution and model choice disagree with the economy.
 */
{
  const rules = server['rules.js'] || '';
  const cfg = client['config.js'] || '';
  const grab = (src) =>
    [...src.matchAll(/level:\s*(\d+)[^}]*?min:\s*(\d+)[^}]*?model:\s*'([^']+)'/g)]
      .map((m) => `${m[1]}:${m[2]}:${m[3]}`);
  const a = grab(rules);
  const b = grab(cfg);
  if (!a.length || !b.length) {
    console.log(`  ${dim('SKIP')} level band parity (could not parse both sides)`);
  } else {
    const diff = a.filter((x, i) => b[i] !== x);
    diff.length
      ? fail('level band parity', diff.map((d) => `server has ${d}, client differs`))
      : pass(`level band parity (${a.length} bands)`);
  }
}

// -------------------------------------------------------- shared geometry ---
/**
 * Guards a specific bug: disposing geometry that other instances still use
 * frees a live GPU buffer and renders corrupted meshes.
 */
{
  const problems = [];
  for (const [file, src] of Object.entries(client)) {
    src.split('\n').forEach((line, i) => {
      // Skip comments — this file documents the bug it guards against, and
      // flagging its own explanation would train people to ignore the check.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (/\.(geometry|material)\.dispose\(\)/.test(line) && !line.includes('?.')) {
        problems.push(`${file}:${i + 1} unguarded dispose — is that geometry shared?`);
      }
    });
  }
  problems.length ? fail('disposal safety', problems) : pass('disposal safety');
}

console.log('');
if (failures) {
  console.log(red(`${failures} check(s) failed.\n`));
  process.exit(1);
}
console.log(green('All checks passed.'));
console.log(dim('Note: this proves the code can run, not that it looks right.\n'));