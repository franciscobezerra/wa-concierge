// Daily concierge digest — the feature this product exists for.
//
// Once a day (config.digest.hour), for each connected account:
//   1. Find conversations possibly left hanging: DM chats whose LAST message
//      is inbound (not from you) and older than stale_hours. Pure SQL, no AI.
//   2. For the top N, draft a suggested reply using the Claude Code CLI the
//      user already has (`claude -p`). No API key, uses their subscription.
//      If the CLI is missing or fails, the digest still goes out without drafts.
//   3. Deliver to the owner's own WhatsApp chat ("message yourself").
//
// The prompt is piped via STDIN (utf-8), never argv — Windows codepages corrupt
// accented text in command-line arguments.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/database');
const { config } = require('../config');

const STATE_PATH = path.join(__dirname, '..', '..', 'data', 'concierge-state.json');
const CLAUDE_TIMEOUT_MS = 90_000;

let timer = null;

// ---------- state (one digest per day) ----------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s));
  } catch (err) {
    console.error('[Concierge] state write failed:', err.message);
  }
}
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- find unanswered chats ----------
function findUnanswered() {
  const now = Math.floor(Date.now() / 1000);
  const lookbackCutoff = now - config.digest.lookback_hours * 3600;
  const staleCutoff = now - config.digest.stale_hours * 3600;
  const groupFilter = config.digest.include_groups ? '' : 'AND is_group = 0';

  const rows = db.getDb().prepare(`
    WITH last_per_chat AS (
      SELECT account_id, chat_id, MAX(timestamp) AS last_ts
      FROM messages
      WHERE timestamp > ? ${groupFilter}
        AND chat_id != 'status@broadcast'
        AND chat_id NOT LIKE '%@newsletter'
      GROUP BY account_id, chat_id
    )
    SELECT m.account_id, m.chat_id, m.sender_name, m.content, m.timestamp, m.is_group
    FROM messages m
    JOIN last_per_chat l
      ON m.account_id = l.account_id AND m.chat_id = l.chat_id AND m.timestamp = l.last_ts
    WHERE m.is_from_me = 0 AND m.timestamp <= ?
    GROUP BY m.account_id, m.chat_id
    ORDER BY m.timestamp DESC
  `).all(lookbackCutoff, staleCutoff);

  // Exclude the owner's own numbers (message-yourself chats must never count).
  const ownPhones = new Set(db.getAccounts().map(a => a.phone).filter(Boolean));
  return rows.filter(r => !ownPhones.has(r.chat_id.split('@')[0]));
}

function chatDisplayName(row) {
  const contact = db.getContactById(row.chat_id);
  return (contact && (contact.name || contact.push_name)) || row.sender_name || row.chat_id.split('@')[0];
}

function hoursAgo(ts) {
  const h = (Date.now() / 1000 - ts) / 3600;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}min` : `${Math.round(h)}h`;
}

// ---------- reply drafts via the user's own Claude Code CLI ----------
function claudeDraft(promptText) {
  return new Promise((resolvePromise) => {
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolvePromise(v); } };
    let child;
    try {
      child = spawn('claude', ['-p'], { shell: process.platform === 'win32', windowsHide: true });
    } catch {
      return done(null);
    }
    const killer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, CLAUDE_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(killer); done(null); }); // CLI not installed
    child.stdout.on('data', (d) => { out += d.toString('utf-8'); });
    child.on('close', (code) => {
      clearTimeout(killer);
      const text = out.trim();
      done(code === 0 && text && text.length < 1200 ? text : null);
    });
    child.stdin.write(promptText, 'utf-8');
    child.stdin.end();
  });
}

async function draftReply(row, displayName) {
  const history = db.getDb().prepare(`
    SELECT sender_name, content, is_from_me FROM messages
    WHERE account_id = ? AND chat_id = ? AND media_type IS NULL
    ORDER BY timestamp DESC LIMIT 10
  `).all(row.account_id, row.chat_id).reverse();

  const transcript = history
    .map(m => `${m.is_from_me ? 'Eu' : (m.sender_name || displayName)}: ${m.content}`)
    .join('\n');

  const prompt =
    `Você é o assistente de WhatsApp do usuário. A conversa abaixo ficou sem resposta ` +
    `(a última mensagem é de ${displayName} e o usuário ainda não respondeu).\n\n` +
    `${transcript}\n\n` +
    `Escreva UM rascunho curto de resposta em nome do usuário (a pessoa que aparece como "Eu"), no tom da conversa. ` +
    `Responda APENAS com o texto do rascunho, sem aspas, sem explicação, sem opções alternativas.`;

  return claudeDraft(prompt);
}

// ---------- build + send ----------
async function buildDigestForAccount(account, items) {
  const lines = [`🤖 *Resumo do dia (WhatsApp ${account.name})*`, ''];

  if (items.length === 0) {
    lines.push('✅ Nenhuma conversa esquecida nas últimas 24h. Bom trabalho!');
    return lines.join('\n');
  }

  lines.push(`*${items.length} conversa(s) possivelmente esquecida(s):*`, '');
  let draftsDone = 0;

  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    const name = chatDisplayName(row);
    const preview = (row.content || '').slice(0, 120).replace(/\n/g, ' ');
    lines.push(`${i + 1}. *${name}* (há ${hoursAgo(row.timestamp)})`);
    lines.push(`   _"${preview}"_`);

    if (draftsDone < config.digest.max_drafts) {
      const draft = await draftReply(row, name);
      if (draft) {
        lines.push(`   💬 Sugestão: ${draft}`);
        draftsDone++;
      }
    }
    lines.push('');
  }

  lines.push('_Para responder: abra o chat no WhatsApp, ou peça ao seu Claude Code:_');
  lines.push('_"responde o(a) <nome> dizendo que..."_');
  return lines.join('\n');
}

async function runDigest() {
  const wa = require('../whatsapp/connection');
  const unanswered = findUnanswered();
  const accounts = db.getAccounts().filter(a => a.connected === 1 && a.phone);

  for (const account of accounts) {
    const conn = wa.getConnection(account.id);
    if (!conn || !conn.ready) {
      console.error(`[Concierge] Account "${account.id}" not connected — skipping its digest`);
      continue;
    }
    const items = unanswered.filter(r => r.account_id === account.id);
    const text = await buildDigestForAccount(account, items);
    try {
      await wa.sendMessage(account.id, `${account.phone}@s.whatsapp.net`, text);
      console.log(`[Concierge] Digest sent for "${account.id}" (${items.length} items)`);
    } catch (err) {
      console.error(`[Concierge] Digest send failed for "${account.id}": ${err.message}`);
    }
  }
}

// ---------- scheduling ----------
async function tick() {
  if (!config.digest.enabled) return;
  const now = new Date();
  if (now.getHours() < config.digest.hour) return;
  const today = localDateStr(now);
  const state = readState();
  if (state.last_digest_date === today) return;

  // Claim the day BEFORE running (a crashing digest must not retry-loop all day).
  writeState({ ...state, last_digest_date: today });
  try {
    await runDigest();
  } catch (err) {
    console.error('[Concierge] Digest run failed:', err.message);
  }
}

function startConcierge() {
  if (timer) return;
  timer = setInterval(() => tick().catch(() => {}), 60 * 1000);
  console.log(`[Concierge] Started — daily digest at ${String(config.digest.hour).padStart(2, '0')}:00`);
}

function stopConcierge() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { startConcierge, stopConcierge, runDigest, findUnanswered };
