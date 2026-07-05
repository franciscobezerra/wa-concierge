const whatsapp = require('./whatsapp/connection');
const db = require('./db/database');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log('=== WhatsApp MCP - Account Manager ===\n');

  // Load existing accounts
  const existingAccounts = db.getAccounts();
  if (existingAccounts.length > 0) {
    console.log('Existing accounts found:');
    existingAccounts.forEach(a => console.log(`  - ${a.id}: ${a.name} (${a.type})`));
    console.log('');

    const reconnect = await ask('Reconnect all existing accounts? (y/n): ');
    if (reconnect.toLowerCase() === 'y') {
      for (const acc of existingAccounts) {
        console.log(`\nConnecting ${acc.name}...`);
        await whatsapp.connectAccount(acc.id, acc.name, acc.type);
        // Wait a bit between connections
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  console.log('\nCommands:');
  console.log('  add      - Add a new WhatsApp account');
  console.log('  list     - List accounts and status');
  console.log('  connect  - Connect a specific account');
  console.log('  send     - Send a test message');
  console.log('  chats    - List recent chats');
  console.log('  quit     - Exit\n');

  while (true) {
    const cmd = await ask('\n> ');

    switch (cmd.trim().toLowerCase()) {
      case 'add': {
        const id = await ask('Account ID (e.g. "personal" or "business"): ');
        const name = await ask('Account name: ');
        const type = await ask('Type (personal/business): ');
        if (!['personal', 'business'].includes(type)) {
          console.log('Invalid type. Use "personal" or "business".');
          break;
        }
        db.saveAccount({ id, name, type, phone: '', connected: 0 });
        console.log(`Account "${name}" saved. Connecting...`);
        await whatsapp.connectAccount(id, name, type);
        console.log('Scan the QR code above with your WhatsApp app.');
        break;
      }

      case 'list': {
        const conns = whatsapp.getAllConnections();
        const accounts = db.getAccounts();
        if (accounts.length === 0) {
          console.log('No accounts configured.');
        } else {
          accounts.forEach(a => {
            const live = conns.find(c => c.id === a.id);
            const status = live?.ready ? 'CONNECTED' : 'DISCONNECTED';
            console.log(`  [${status}] ${a.id}: ${a.name} (${a.type}) - ${a.phone || 'no phone'}`);
          });
        }
        break;
      }

      case 'connect': {
        const id = await ask('Account ID to connect: ');
        const acc = db.getAccounts().find(a => a.id === id);
        if (!acc) {
          console.log('Account not found.');
          break;
        }
        await whatsapp.connectAccount(acc.id, acc.name, acc.type);
        break;
      }

      case 'send': {
        const accId = await ask('Account ID: ');
        const phone = await ask('Phone number (with country code, e.g. 5511999999999): ');
        const text = await ask('Message: ');
        try {
          await whatsapp.sendMessage(accId, phone, text);
          console.log('Message sent!');
        } catch (err) {
          console.log(`Error: ${err.message}`);
        }
        break;
      }

      case 'chats': {
        const accId = await ask('Account ID (or press Enter for all): ');
        const chats = db.getChats({ account_id: accId || undefined, limit: 20 });
        if (chats.length === 0) {
          console.log('No chats found yet. Messages will appear as they arrive.');
        } else {
          chats.forEach(c => {
            const time = new Date(c.last_message_time * 1000).toLocaleString();
            console.log(`  ${c.chat_name} (${c.message_count} msgs, last: ${time})`);
            console.log(`    ${c.last_message?.substring(0, 80) || ''}`);
          });
        }
        break;
      }

      case 'quit':
      case 'exit':
        console.log('Goodbye!');
        rl.close();
        process.exit(0);

      default:
        console.log('Unknown command. Try: add, list, connect, send, chats, quit');
    }
  }
}

main().catch(console.error);
