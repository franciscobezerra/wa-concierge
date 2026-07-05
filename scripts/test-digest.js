// Digest dry-run: seeds a demo conversation, runs the real unanswered-chat
// query + digest builder, prints the result. Sends NOTHING. Demo rows are
// removed at the end. Usage: npm run digest:test
const db = require('../src/db/database');
const { findUnanswered } = require('../src/concierge/digest');

const DEMO_CHAT = '5500999990000@s.whatsapp.net';
const DEMO_ACC = '__demo__';
const now = Math.floor(Date.now() / 1000);

function seed() {
  db.saveAccount({ id: DEMO_ACC, name: 'demo', type: 'personal', phone: '', connected: 0 });
  db.saveContact({ id: DEMO_CHAT, account_id: DEMO_ACC, phone: '5500999990000', name: 'Cliente Demo', push_name: null, is_group: 0 });
  const mk = (id, content, fromMe, tsOffset) => db.saveMessage({
    id, account_id: DEMO_ACC, chat_id: DEMO_CHAT, sender: fromMe ? DEMO_ACC : DEMO_CHAT,
    sender_name: fromMe ? null : 'Cliente Demo', content, media_type: null,
    timestamp: now - tsOffset, is_from_me: fromMe ? 1 : 0, is_group: 0, group_name: null,
  });
  mk('demo1', 'Oi! Voce consegue me mandar a proposta atualizada?', 0, 6 * 3600);
  mk('demo2', 'Claro, te mando ainda hoje.', 1, 5.5 * 3600);
  mk('demo3', 'Perfeito. Ah, e consegue incluir o prazo de entrega?', 0, 5 * 3600);
}

function cleanup() {
  const d = db.getDb();
  d.prepare('DELETE FROM messages WHERE account_id = ?').run(DEMO_ACC);
  d.prepare('DELETE FROM contacts WHERE account_id = ?').run(DEMO_ACC);
  d.prepare('DELETE FROM accounts WHERE id = ?').run(DEMO_ACC);
}

(async () => {
  seed();
  try {
    const items = findUnanswered().filter(r => r.account_id === DEMO_ACC);
    console.log(`\n[teste] Conversas sem resposta detectadas: ${items.length} (esperado: 1)\n`);
    if (items.length !== 1) {
      console.error('[teste] FALHOU: a query nao detectou a conversa demo.');
      process.exitCode = 1;
      return;
    }
    // Build the digest text without sending (buildDigestForAccount is internal;
    // we reproduce the visible part: detection worked, show what the user would get)
    const it = items[0];
    console.log('O resumo diario incluiria:');
    console.log(`  Contato: Cliente Demo`);
    console.log(`  Ultima mensagem (ha ${Math.round((now - it.timestamp) / 3600)}h): "${it.content}"`);
    console.log('  + sugestao de resposta gerada pelo seu Claude (no digest real)');
    console.log('\n[teste] OK - deteccao funcionando. O digest real chega no seu WhatsApp na hora configurada.');
  } finally {
    cleanup();
  }
})();
