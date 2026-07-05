// One-time setup. Run after `npm install`.
//   Interactive:      node scripts/setup.js
//   Non-interactive:  node scripts/setup.js --port 3000 --hour 18
// The guided installer (Claude Code) asks the user in chat and passes flags.
// Generates config.json (unique password), creates the data dirs, and creates
// the MCP access key so the user's Claude Code can talk to their WhatsApp.
// Safe to re-run: keeps existing values unless the user changes them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// --flag value parsing (presence of any flag = non-interactive mode)
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const NON_INTERACTIVE = argv.some(a => a.startsWith('--'));

const rl = NON_INTERACTIVE ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => NON_INTERACTIVE ? Promise.resolve('') : new Promise(r => rl.question(q, r));

function genPassword() {
  // Readable but strong: 4 groups of 4 lowercase+digits
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from(crypto.randomBytes(4)).map(b => alphabet[b % alphabet.length]).join('');
  return `${group()}-${group()}-${group()}-${group()}`;
}

(async () => {
  console.log('=== wa-concierge setup ===\n');

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

  const portAns = flag('port') || await ask(`Porta do dashboard [${existing.port || 3000}]: `);
  const port = parseInt(portAns) || existing.port || 3000;

  const hourAns = flag('hour') ?? await ask(`Hora do resumo diario (0-23) [${existing.digest?.hour ?? 18}]: `);
  const hour = hourAns === '' || hourAns === undefined
    ? (existing.digest?.hour ?? 18)
    : Math.min(23, Math.max(0, parseInt(hourAns) || 18));

  const password = existing.dashboard_password || genPassword();

  const config = {
    port,
    dashboard_password: password,
    digest: { ...(existing.digest || {}), enabled: true, hour },
    health: existing.health || {},
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  fs.mkdirSync(path.join(ROOT, 'data', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'data', 'media'), { recursive: true });

  // MCP access key (stored in the local DB; database.js creates the DB on require)
  const db = require('../src/db/database');
  let profile = db.getAiProfiles().find(p => p.name === 'owner');
  if (!profile) {
    // Empty allowed_accounts = access to all accounts (see mcp-entry.js)
    profile = db.createAiProfile({ name: 'owner', allowed_accounts: [] });
  }

  console.log('\n=== Pronto! Guarde estes dados ===\n');
  console.log(`Dashboard:        http://localhost:${port}`);
  console.log(`Senha dashboard:  ${password}`);
  console.log(`Resumo diario:    ${String(hour).padStart(2, '0')}:00 (no seu proprio WhatsApp)`);
  console.log(`Chave MCP:        ${profile.api_key}`);
  console.log('\nRegistre no Claude Code (um comando so):');
  const entry = path.join(ROOT, 'src', 'mcp-entry.js');
  console.log(`  claude mcp add whatsapp -- node "${entry}" --key ${profile.api_key}`);
  console.log('\nProximo passo: npm start  (depois abra o dashboard e escaneie o QR)');
  if (rl) rl.close();
})();
