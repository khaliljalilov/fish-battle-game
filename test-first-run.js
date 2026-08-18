const path = require('path');
const fs = require('fs');
const { resolvePackagedConfig } = require('./electron/firstRunConfig');

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

const userData = path.join(process.env.APPDATA || process.env.HOME || '.', 'tiktok-fish-battle');
const configDir = path.join(userData, 'config');
const gameEnvPath = path.join(configDir, 'game.env');

console.log('User data path:', userData);
console.log('Expecting config at:', gameEnvPath);

try {
  if (fs.existsSync(gameEnvPath)) {
    const bak = `${gameEnvPath}.bak.${timestamp()}`;
    fs.copyFileSync(gameEnvPath, bak);
    console.log('Backed up existing game.env to', bak);
  } else {
    console.log('No existing game.env found (ok).');
  }

  // Call the sanitized resolver which will remove any MONGO_* keys and
  // rewrite the on-disk file (writeToDisk: true).
  const { game, configDir: writtenDir, adminKeyFreshlyGenerated } = resolvePackagedConfig(userData, { writeToDisk: true });

  console.log('\nReturned game keys (in-memory):', Object.keys(game).join(', '));
  console.log('adminKeyFreshlyGenerated:', !!adminKeyFreshlyGenerated);

  if (fs.existsSync(gameEnvPath)) {
    console.log('\n--- game.env after sanitization (start) ---');
    console.log(fs.readFileSync(gameEnvPath, 'utf8'));
    console.log('--- game.env after sanitization (end) ---');
  } else {
    console.log('\nNo game.env was written to disk.');
  }

  console.log('\nIf MONGO_* were present before, they should now be removed from the on-disk file.');
} catch (err) {
  console.error('Error during test run:', err);
  process.exitCode = 1;
}
