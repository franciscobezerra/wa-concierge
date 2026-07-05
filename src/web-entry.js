process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});

const { start } = require('./web/server');
const whatsapp = require('./whatsapp/connection');
const db = require('./db/database');
const { config } = require('./config');
const { startScheduler } = require('./scheduler/scheduler');
const { startHealthMonitor } = require('./monitor/health-monitor');
const { startConcierge } = require('./concierge/digest');

const port = parseInt(process.env.PORT) || config.port;
start(port);

// Auto-connect all saved accounts on startup
(async () => {
  const accounts = db.getAccounts();
  for (const acc of accounts) {
    console.log(`[WEB] Auto-connecting account: ${acc.name} (${acc.id})`);
    try {
      await whatsapp.connectAccount(acc.id, acc.name, acc.type);
    } catch (err) {
      console.error(`[WEB] Failed to connect ${acc.id}: ${err.message}`);
    }
  }

  // Start scheduler after accounts are connected
  startScheduler();

  // Health monitor: self-healing reconnects + owner alerts via message-yourself
  startHealthMonitor();

  // Concierge: daily digest of possibly-missed conversations + reply drafts
  startConcierge();
})();
