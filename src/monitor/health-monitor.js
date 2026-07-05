// Health monitor with SELF-HEALING.
//
// Baileys' built-in retry gives up after MAX_RETRIES (see whatsapp/connection.js).
// Without this monitor, a dropped account stays down silently until a human
// notices — the exact failure mode this product exists to prevent. So:
//
//   1. AUTOHEAL: every N minutes, any account that should be connected but
//      isn't — and still has auth state on disk — gets reconnected. Saved auth
//      means no QR needed; this recovers from network blips, PC sleep, etc.
//   2. ALERTS: sent to the owner's own WhatsApp ("message yourself") via any
//      account that is still alive. Only for things a human must act on
//      (logged out -> QR re-scan). Self-healed drops stay silent.
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { config } = require('../config');

const AUTH_ROOT = path.join(__dirname, '..', '..', 'data', 'auth');
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // don't nag: 1 alert per account per 4h
const lastAlertAt = new Map();

let wa;
let healTimer = null;

function authPresent(accountId) {
  try {
    const dir = path.join(AUTH_ROOT, accountId);
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// Send to the owner's own chat ("message yourself") via any live account.
async function alertOwner(text) {
  const live = (wa.getAllConnections() || []).filter(c => c.ready && c.phone);
  if (live.length === 0) {
    console.error(`[HealthMonitor] No live account to deliver alert: ${text}`);
    return false;
  }
  const sender = live[0];
  try {
    await wa.sendMessage(sender.id, `${sender.phone}@s.whatsapp.net`, `🤖 ${text}`);
    return true;
  } catch (err) {
    console.error(`[HealthMonitor] Alert send failed: ${err.message}`);
    return false;
  }
}

function canAlert(accountId) {
  const last = lastAlertAt.get(accountId) || 0;
  return Date.now() - last > ALERT_COOLDOWN_MS;
}

async function healPass() {
  const accounts = db.getAccounts().filter(a => a.connected === 1);
  for (const acc of accounts) {
    const conn = wa.getConnection(acc.id);
    if (conn && conn.ready) continue; // healthy

    if (authPresent(acc.id)) {
      // Recoverable: socket died but session credentials survive. Reconnect
      // silently — this is the cure, not something the owner needs to see.
      console.log(`[HealthMonitor] Account "${acc.id}" is down with saved auth — reconnecting...`);
      try {
        await wa.connectAccount(acc.id, acc.name, acc.type);
      } catch (err) {
        console.error(`[HealthMonitor] Reconnect of "${acc.id}" failed: ${err.message}`);
      }
    } else if (canAlert(acc.id)) {
      // Not recoverable without a human: session was invalidated (auth wiped).
      lastAlertAt.set(acc.id, Date.now());
      await alertOwner(
        `Conta WhatsApp "${acc.name}" foi deslogada e precisa de um novo QR code.\n` +
        `Abra http://localhost:${config.port} no PC, clique em Conectar na conta "${acc.name}" e escaneie o QR.`
      );
    }
  }
}

function onEvent(event) {
  if (event.type !== 'connection') return;
  const { accountId, accountName, status } = event.data;

  if (status === 'connected') {
    lastAlertAt.delete(accountId);
    return;
  }
  // Session invalidated (auth wiped by connection.js) — needs QR, tell the owner now.
  if (status === 'logged_out' && canAlert(accountId)) {
    lastAlertAt.set(accountId, Date.now());
    alertOwner(
      `Conta WhatsApp "${accountName}" foi deslogada e precisa de um novo QR code.\n` +
      `Abra http://localhost:${config.port} no PC, clique em Conectar e escaneie o QR.`
    );
  }
  // 'disconnected'/'reconnecting'/'failed' stay silent: the heal pass fixes them.
}

function startHealthMonitor() {
  wa = require('../whatsapp/connection');
  wa.onEvent(onEvent);
  const intervalMs = (config.health.autoheal_interval_min || 5) * 60 * 1000;
  healTimer = setInterval(() => healPass().catch(err => console.error('[HealthMonitor]', err.message)), intervalMs);
  console.log(`[HealthMonitor] Started — autoheal every ${config.health.autoheal_interval_min}min, alerts via message-yourself`);
}

function stopHealthMonitor() {
  if (healTimer) { clearInterval(healTimer); healTimer = null; }
}

module.exports = { startHealthMonitor, stopHealthMonitor };
