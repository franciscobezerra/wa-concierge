const db = require('../db/database');
const { config } = require('../config');

let interval = null;
let running = false;

async function checkAndSend() {
  if (running) return;
  running = true;

  try {
    const now = Math.floor(Date.now() / 1000);
    const pending = db.getPendingScheduledMessages(now);

    for (const msg of pending) {
      try {
        // Check group interaction permission if it's a group
        if (msg.chat_id.endsWith('@g.us') && !db.isGroupInteractable(msg.chat_id, msg.account_id)) {
          db.updateScheduledMessageStatus(msg.id, 'failed', 'Group interaction not allowed');
          continue;
        }

        // Send via web server API (same pattern as MCP)
        const port = process.env.PORT || config.port;
        const res = await fetch(`http://localhost:${port}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: msg.account_id, chat_id: msg.chat_id, text: msg.text }),
        });
        const data = await res.json();

        if (data.error) {
          db.updateScheduledMessageStatus(msg.id, 'failed', data.error);
          console.error(`[Scheduler] Failed to send scheduled message ${msg.id}: ${data.error}`);
        } else {
          db.updateScheduledMessageStatus(msg.id, 'sent');
          console.log(`[Scheduler] Sent scheduled message ${msg.id} to ${msg.chat_id}`);
        }
      } catch (err) {
        db.updateScheduledMessageStatus(msg.id, 'failed', err.message);
        console.error(`[Scheduler] Error sending ${msg.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Check error:', err.message);
  } finally {
    running = false;
  }
}

function startScheduler(intervalMs = 15000) {
  if (interval) return;
  console.log(`[Scheduler] Started (checking every ${intervalMs / 1000}s)`);
  interval = setInterval(checkAndSend, intervalMs);
  // Run immediately on start
  checkAndSend();
}

function stopScheduler() {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log('[Scheduler] Stopped');
  }
}

module.exports = { startScheduler, stopScheduler };
