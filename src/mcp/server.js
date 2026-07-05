const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const db = require('../db/database');
const { resolveLidToJid } = require('../whatsapp/connection');

// Guard: reject if account not in allowed list
function assertAllowed(allowedAccounts, accountId) {
  if (allowedAccounts && !allowedAccounts.includes(accountId)) {
    throw new Error(`Access denied: account "${accountId}" is not allowed for this MCP session. Allowed: ${allowedAccounts.join(', ')}`);
  }
}

// Filter: only return data for allowed accounts
function filterByAllowed(allowedAccounts, items, key = 'id') {
  if (!allowedAccounts) return items;
  return items.filter(item => allowedAccounts.includes(item[key]));
}

function createMcpServer(allowedAccounts) {
  const server = new McpServer({
    name: 'whatsapp-mcp',
    version: '1.0.0',
  });

  const restrictionNote = allowedAccounts
    ? ` (restricted to: ${allowedAccounts.join(', ')})`
    : ' (all accounts)';

  // --- Tools ---

  server.tool(
    'list_accounts',
    'List WhatsApp accounts and their connection status' + restrictionNote,
    {},
    async () => {
      let accounts = db.getAccounts();
      accounts = filterByAllowed(allowedAccounts, accounts);
      const result = accounts.map(acc => ({
        ...acc,
        live_connected: !!acc.connected,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'list_chats',
    'List recent chats/conversations' + restrictionNote,
    {
      account_id: z.string().optional().describe('Filter by account ID'),
      limit: z.number().optional().default(30).describe('Max number of chats to return'),
    },
    async ({ account_id, limit }) => {
      if (account_id) assertAllowed(allowedAccounts, account_id);
      const effectiveAccount = account_id || (allowedAccounts?.length === 1 ? allowedAccounts[0] : undefined);
      let chats = db.getChats({ account_id: effectiveAccount, limit: limit * 2 });
      if (allowedAccounts && !effectiveAccount) {
        chats = chats.filter(c => allowedAccounts.includes(c.account_id));
      }
      // Filter out groups without read permission
      chats = chats.filter(c => !c.is_group || db.isGroupReadable(c.chat_id, c.account_id));
      chats = chats.slice(0, limit);
      return { content: [{ type: 'text', text: JSON.stringify(chats, null, 2) }] };
    }
  );

  server.tool(
    'read_messages',
    'Read messages from a specific chat' + restrictionNote,
    {
      account_id: z.string().describe('The account ID'),
      chat_id: z.string().describe('The chat/contact JID (e.g. 5511999999999@s.whatsapp.net)'),
      limit: z.number().optional().default(50).describe('Max messages to return'),
      before_timestamp: z.number().optional().describe('Return messages before this Unix timestamp'),
    },
    async ({ account_id, chat_id, limit, before_timestamp }) => {
      assertAllowed(allowedAccounts, account_id);
      // Check group read permission
      if (chat_id && chat_id.endsWith('@g.us') && !db.isGroupReadable(chat_id, account_id)) {
        return { content: [{ type: 'text', text: `Access denied: reading from this group is not allowed.` }], isError: true };
      }
      const messages = db.getMessages({ account_id, chat_id, limit, before_timestamp });
      return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] };
    }
  );

  server.tool(
    'search_messages',
    'Search messages by content' + restrictionNote,
    {
      search: z.string().describe('Text to search for in message content'),
      account_id: z.string().optional().describe('Filter by account ID'),
      chat_id: z.string().optional().describe('Filter by chat ID'),
      limit: z.number().optional().default(30).describe('Max results'),
    },
    async ({ search, account_id, chat_id, limit }) => {
      if (account_id) assertAllowed(allowedAccounts, account_id);
      const effectiveAccount = account_id || (allowedAccounts?.length === 1 ? allowedAccounts[0] : undefined);
      let messages = db.getMessages({ account_id: effectiveAccount, chat_id, search, limit: limit * 2 });
      if (allowedAccounts && !effectiveAccount) {
        messages = messages.filter(m => allowedAccounts.includes(m.account_id));
      }
      // Filter out messages from blocked groups
      messages = messages.filter(m => !m.is_group || db.isGroupReadable(m.chat_id, m.account_id));
      messages = messages.slice(0, limit);
      return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] };
    }
  );

  server.tool(
    'list_contacts',
    'Search contacts by name or phone number. IMPORTANT: Always provide the "search" parameter to filter results — do NOT call without search, as the full list is too large. Contacts are shared across all WhatsApp accounts. To send a message to a contact by name, prefer using send_message_to_contact instead.',
    {
      search: z.string().describe('Search by name or phone number. Required — always provide a search term.'),
      limit: z.number().optional().default(20).describe('Max contacts to return (default 20)'),
    },
    async ({ search, limit }) => {
      // Contacts are shared across all accounts — always search globally
      let contacts = db.getContacts({ search, limit: (limit || 20) * 2 }); // fetch extra to account for dedup
      // Resolve LIDs to JIDs and deduplicate by resolved ID
      const seen = new Set();
      const result = [];
      for (const c of contacts) {
        const resolvedId = resolveLidToJid(c.id);
        if (seen.has(resolvedId)) continue;
        seen.add(resolvedId);
        // Skip unresolved LIDs — they can't be used for sending
        if (resolvedId.endsWith('@lid')) continue;
        result.push({
          id: resolvedId,
          phone: resolvedId.split('@')[0],
          name: c.name,
          push_name: c.push_name,
          is_group: c.is_group,
          updated_at: c.updated_at,
        });
        if (result.length >= (limit || 20)) break;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'send_message',
    'Send a text message via WhatsApp. You can pass a chat_id (JID like 5511999999999@s.whatsapp.net or group@g.us), a plain phone number, or a contact name. When a contact name is provided, the system will look it up and only send if there is exactly one exact match. If you only have a contact name, prefer using send_message_to_contact instead.' + restrictionNote,
    {
      account_id: z.string().describe('The account ID to send from'),
      chat_id: z.string().describe('The recipient: a JID (phone@s.whatsapp.net or group@g.us), a plain phone number, or a contact name'),
      text: z.string().describe('The message text to send'),
    },
    async ({ account_id, chat_id, text }) => {
      try {
        assertAllowed(allowedAccounts, account_id);

        // Check if chat_id is a valid JID or phone number
        const isJID = chat_id.includes('@s.whatsapp.net') || chat_id.includes('@g.us');
        const isPhone = /^\+?\d[\d\s\-()]{6,}$/.test(chat_id.trim());

        let resolvedChatId = chat_id;

        if (!isJID && !isPhone) {
          // chat_id looks like a contact name — search across ALL accounts (contacts are shared)
          const contacts = db.getContacts({ search: chat_id, is_group: 0 });

          if (contacts.length === 0) {
            return {
              content: [{ type: 'text', text: `No contact found matching "${chat_id}". Ask the user for the exact phone number (with country code), or ask them to verify the contact name.` }],
              isError: true,
            };
          }

          // Check for exact name match (case-insensitive)
          const needle = chat_id.toLowerCase().trim();
          const exactMatches = contacts.filter(c => {
            const name = (c.name || '').toLowerCase().trim();
            const pushName = (c.push_name || '').toLowerCase().trim();
            return name === needle || pushName === needle;
          });

          if (exactMatches.length === 1) {
            resolvedChatId = resolveLidToJid(exactMatches[0].id);
          } else {
            // Multiple or no exact matches — do NOT send, return options
            const suggestions = contacts.map(c => {
              const resolved = resolveLidToJid(c.id);
              return {
                name: c.name || c.push_name || 'Unknown',
                phone: resolved.endsWith('@s.whatsapp.net') ? resolved.split('@')[0] : (c.phone || c.id),
                chat_id: resolved,
              };
            });

            const intro = exactMatches.length > 1
              ? `Found ${exactMatches.length} contacts with the exact name "${chat_id}"`
              : `No exact match for "${chat_id}", but found ${contacts.length} similar contact(s)`;

            return {
              content: [{ type: 'text', text: `${intro}. The message was NOT sent to avoid sending to the wrong person. Ask the user which contact they mean:\n\n${JSON.stringify(suggestions, null, 2)}\n\nOnce confirmed, call send_message again with the correct chat_id (the JID from the list above).` }],
              isError: true,
            };
          }
        }

        // Check group interaction permission
        if (resolvedChatId.endsWith('@g.us') && !db.isGroupInteractable(resolvedChatId, account_id)) {
          return { content: [{ type: 'text', text: `Access denied: interaction with this group is not allowed.` }], isError: true };
        }

        // Send via web dashboard API
        const port = process.env.PORT || 3000;
        const res = await fetch(`http://localhost:${port}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id, chat_id: resolvedChatId, text }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return { content: [{ type: 'text', text: `Message sent successfully. ID: ${data.message_id}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}. Make sure the dashboard (npm start) is running.` }], isError: true };
      }
    }
  );

  server.tool(
    'send_message_to_contact',
    'PREFERRED way to send a message when you only have the contact name. Looks up the contact by name in the shared contacts database and sends the message. If there is exactly one exact match, sends automatically. If multiple or no exact matches, returns suggestions for the user to choose from. The message is NEVER sent to the wrong person.' + restrictionNote,
    {
      contact_name: z.string().describe('The name (or partial name) of the contact to send the message to'),
      text: z.string().describe('The message text to send'),
      account_id: z.string().optional().describe('The account ID to send from. If omitted and only one account is available, uses that one.'),
    },
    async ({ contact_name, text, account_id }) => {
      try {
        if (account_id) assertAllowed(allowedAccounts, account_id);

        // Search contacts by name across ALL accounts (contacts are shared)
        let matches = db.getContacts({ search: contact_name, is_group: 0 });

        // Deduplicate by contact id (same person may exist in multiple accounts)
        const seen = new Set();
        matches = matches.filter(c => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });

        // No matches found
        if (matches.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No contact found matching "${contact_name}". Please ask the user for the exact phone number (with country code) to send the message, or ask them to verify the contact name.`
            }],
            isError: true,
          };
        }

        // Check for exact name match (case-insensitive)
        const needle = contact_name.toLowerCase().trim();
        const exactMatches = matches.filter(c => {
          const name = (c.name || '').toLowerCase().trim();
          const pushName = (c.push_name || '').toLowerCase().trim();
          return name === needle || pushName === needle;
        });

        // Only auto-send if there is exactly ONE exact match
        if (exactMatches.length === 1) {
          const contact = exactMatches[0];
          // Determine send account: explicit > first allowed > contact's account
          let sendAccountId = account_id;
          if (!sendAccountId && allowedAccounts && allowedAccounts.length > 0) {
            sendAccountId = allowedAccounts[0];
          }
          if (!sendAccountId) {
            sendAccountId = contact.account_id;
          }

          // Resolve LID to JID for sending
          const resolvedChatId = resolveLidToJid(contact.id);

          // If multiple allowed accounts and none specified, ask user which to send from
          if (!account_id && allowedAccounts && allowedAccounts.length > 1) {
            const resolvedPhone = resolvedChatId.endsWith('@s.whatsapp.net') ? resolvedChatId.split('@')[0] : (contact.phone || contact.id);
            return {
              content: [{
                type: 'text',
                text: `Found contact "${contact.name || contact.push_name}" (${resolvedPhone}). You have access to multiple accounts: ${allowedAccounts.join(', ')}. Which account should be used to send the message? Call send_message with the chosen account_id and chat_id: ${resolvedChatId}`
              }]
            };
          }

          const port = process.env.PORT || 3000;
          const res = await fetch(`http://localhost:${port}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id: sendAccountId, chat_id: resolvedChatId, text }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return {
            content: [{
              type: 'text',
              text: `Message sent to ${contact.name || contact.push_name || contact.phone} (${contact.phone || contact.id}) via account "${sendAccountId}". Message ID: ${data.message_id}`
            }]
          };
        }

        // Multiple matches or no exact match: always ask the user to confirm
        const suggestions = matches.map(c => {
          const resolved = resolveLidToJid(c.id);
          return {
            name: c.name || c.push_name || 'Unknown',
            phone: resolved.endsWith('@s.whatsapp.net') ? resolved.split('@')[0] : (c.phone || c.id),
            chat_id: resolved,
          };
        });

        const intro = exactMatches.length > 1
          ? `Found ${exactMatches.length} contacts with the exact name "${contact_name}"`
          : `No exact match for "${contact_name}", but found ${matches.length} similar contact(s)`;

        return {
          content: [{
            type: 'text',
            text: `${intro}. The message was NOT sent. Ask the user which contact they mean:\n\n${JSON.stringify(suggestions, null, 2)}\n\nOnce the user confirms, use send_message with the correct account_id and chat_id.`
          }]
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'schedule_message',
    'Schedule a message to be sent at a future time. The message will be automatically sent when the scheduled time arrives.' + restrictionNote,
    {
      account_id: z.string().optional().describe('Account ID to send from. If omitted and only one account is available, uses that one.'),
      chat_id: z.string().describe('Recipient JID, phone number, or contact name'),
      text: z.string().describe('Message text to send'),
      send_at: z.string().describe('When to send: ISO 8601 datetime (e.g. "2026-03-16T14:30:00") or Unix timestamp'),
    },
    async ({ account_id, chat_id, text, send_at }) => {
      try {
        // Resolve account
        const sendAccountId = account_id || (allowedAccounts?.length === 1 ? allowedAccounts[0] : null);
        if (!sendAccountId) {
          return { content: [{ type: 'text', text: `Multiple accounts available: ${(allowedAccounts || []).join(', ')}. Please specify account_id.` }], isError: true };
        }
        assertAllowed(allowedAccounts, sendAccountId);

        // Parse timestamp
        let scheduledAt;
        if (/^\d{10,}$/.test(send_at)) {
          scheduledAt = parseInt(send_at);
        } else {
          scheduledAt = Math.floor(new Date(send_at).getTime() / 1000);
        }
        if (isNaN(scheduledAt) || scheduledAt <= Math.floor(Date.now() / 1000)) {
          return { content: [{ type: 'text', text: 'send_at must be a valid future datetime.' }], isError: true };
        }

        // Resolve contact name to JID if needed
        const isJID = chat_id.includes('@s.whatsapp.net') || chat_id.includes('@g.us');
        const isPhone = /^\+?\d[\d\s\-()]{6,}$/.test(chat_id.trim());
        let resolvedChatId = chat_id;
        let contactName = null;

        if (!isJID && !isPhone) {
          const contacts = db.getContacts({ search: chat_id, is_group: 0 });
          const needle = chat_id.toLowerCase().trim();
          const exactMatches = contacts.filter(c => {
            const name = (c.name || '').toLowerCase().trim();
            const pushName = (c.push_name || '').toLowerCase().trim();
            return name === needle || pushName === needle;
          });

          if (exactMatches.length === 1) {
            resolvedChatId = resolveLidToJid(exactMatches[0].id);
            contactName = exactMatches[0].name || exactMatches[0].push_name;
            if (resolvedChatId.endsWith('@lid')) {
              return { content: [{ type: 'text', text: `Contact "${chat_id}" found but has no valid phone number. Please provide the phone number.` }], isError: true };
            }
          } else if (exactMatches.length > 1 || contacts.length > 0) {
            const suggestions = contacts.slice(0, 10).map(c => {
              const resolved = resolveLidToJid(c.id);
              return { name: c.name || c.push_name || 'Unknown', phone: resolved.split('@')[0], chat_id: resolved };
            });
            return { content: [{ type: 'text', text: `Multiple contacts match "${chat_id}". Ask the user:\n${JSON.stringify(suggestions, null, 2)}` }] };
          } else {
            return { content: [{ type: 'text', text: `No contact found matching "${chat_id}". Please provide the phone number.` }], isError: true };
          }
        }

        if (!resolvedChatId.includes('@')) {
          resolvedChatId = resolvedChatId.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }

        const msg = db.createScheduledMessage({
          account_id: sendAccountId,
          chat_id: resolvedChatId,
          contact_name: contactName || resolvedChatId.split('@')[0],
          text,
          scheduled_at: scheduledAt,
        });

        const sendDate = new Date(scheduledAt * 1000).toLocaleString('pt-BR');
        return { content: [{ type: 'text', text: `Message scheduled for ${sendDate} to ${contactName || resolvedChatId}. ID: ${msg.id}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_scheduled_messages',
    'List scheduled messages' + restrictionNote,
    {
      status: z.string().optional().describe('Filter by status: pending, sent, failed, cancelled'),
    },
    async ({ status }) => {
      const effectiveAccount = allowedAccounts?.length === 1 ? allowedAccounts[0] : undefined;
      let messages = db.getScheduledMessages({ account_id: effectiveAccount, status });
      if (allowedAccounts && !effectiveAccount) {
        messages = messages.filter(m => allowedAccounts.includes(m.account_id));
      }
      return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] };
    }
  );

  server.tool(
    'cancel_scheduled_message',
    'Cancel a pending scheduled message' + restrictionNote,
    {
      message_id: z.string().describe('The ID of the scheduled message to cancel'),
    },
    async ({ message_id }) => {
      const result = db.cancelScheduledMessage(message_id);
      if (result.changes === 0) {
        return { content: [{ type: 'text', text: 'Message not found or already sent/cancelled.' }], isError: true };
      }
      return { content: [{ type: 'text', text: 'Scheduled message cancelled.' }] };
    }
  );

  server.tool(
    'get_unread_summary',
    'Get a summary of recent messages' + restrictionNote,
    {
      since_timestamp: z.number().optional().describe('Unix timestamp to get messages since. Defaults to last hour.'),
      limit: z.number().optional().default(100).describe('Max messages to return'),
    },
    async ({ since_timestamp, limit }) => {
      const since = since_timestamp || Math.floor(Date.now() / 1000) - 3600;
      const allDb = db.getDb();

      let query = `
        SELECT m.*, c.name as contact_name
        FROM messages m
        LEFT JOIN contacts c ON c.id = m.chat_id AND c.account_id = m.account_id
        WHERE m.timestamp > @since AND m.is_from_me = 0
      `;
      const params = { since, limit };

      if (allowedAccounts) {
        const placeholders = allowedAccounts.map((_, i) => `@acc${i}`).join(', ');
        query += ` AND m.account_id IN (${placeholders})`;
        allowedAccounts.forEach((acc, i) => { params[`acc${i}`] = acc; });
      }

      query += ' ORDER BY m.timestamp DESC LIMIT @limit';
      const messages = allDb.prepare(query).all(params);

      const grouped = {};
      for (const msg of messages) {
        const key = `${msg.account_id}:${msg.chat_id}`;
        if (!grouped[key]) {
          grouped[key] = {
            account_id: msg.account_id,
            chat_id: msg.chat_id,
            chat_name: msg.contact_name || msg.group_name || msg.chat_id,
            is_group: msg.is_group,
            messages: [],
          };
        }
        grouped[key].messages.push({
          sender: msg.sender_name || msg.sender,
          content: msg.content,
          timestamp: msg.timestamp,
        });
      }

      return { content: [{ type: 'text', text: JSON.stringify(Object.values(grouped), null, 2) }] };
    }
  );

  server.tool(
    'send_media',
    'Send an image, audio, video, document (PDF, DOCX, etc.) or sticker via WhatsApp. Accepts an absolute local file path OR an http(s) URL. Pass a contact name, a plain phone number, or a JID as the recipient. If media_type is omitted, it is inferred from the file extension.' + restrictionNote,
    {
      account_id: z.string().describe('The account ID to send from'),
      chat_id: z.string().describe('Recipient: JID, plain phone number, or contact name'),
      media_path: z.string().describe('Absolute local path (e.g. C:/Users/you/Downloads/file.pdf or /Users/you/Downloads/file.pdf) or http(s) URL to the media file'),
      media_type: z.enum(['image', 'video', 'audio', 'voice', 'document', 'sticker']).optional().describe('Override the media type. "voice" sends as a WhatsApp voice note (ptt). If omitted, inferred from file extension.'),
      caption: z.string().optional().describe('Optional caption (shown for image/video/document, ignored for audio/voice/sticker)'),
      file_name: z.string().optional().describe('Override filename shown in WhatsApp (document only)'),
    },
    async ({ account_id, chat_id, media_path, media_type, caption, file_name }) => {
      try {
        assertAllowed(allowedAccounts, account_id);

        const isJID = chat_id.includes('@s.whatsapp.net') || chat_id.includes('@g.us');
        const isPhone = /^\+?\d[\d\s\-()]{6,}$/.test(chat_id.trim());
        let resolvedChatId = chat_id;

        if (!isJID && !isPhone) {
          const contacts = db.getContacts({ search: chat_id, is_group: 0 });
          if (contacts.length === 0) {
            return { content: [{ type: 'text', text: `No contact found matching "${chat_id}". Provide an exact phone number or verified contact name.` }], isError: true };
          }
          const needle = chat_id.toLowerCase().trim();
          const exact = contacts.filter(c => (c.name || '').toLowerCase().trim() === needle || (c.push_name || '').toLowerCase().trim() === needle);
          if (exact.length === 1) {
            resolvedChatId = resolveLidToJid(exact[0].id);
          } else {
            const suggestions = contacts.map(c => {
              const resolved = resolveLidToJid(c.id);
              return { name: c.name || c.push_name || 'Unknown', phone: resolved.endsWith('@s.whatsapp.net') ? resolved.split('@')[0] : (c.phone || c.id), chat_id: resolved };
            });
            return { content: [{ type: 'text', text: `Ambiguous contact "${chat_id}". Media NOT sent. Ask user which to use:\n\n${JSON.stringify(suggestions, null, 2)}` }], isError: true };
          }
        }

        if (resolvedChatId.endsWith('@g.us') && !db.isGroupInteractable(resolvedChatId, account_id)) {
          return { content: [{ type: 'text', text: `Access denied: interaction with this group is not allowed.` }], isError: true };
        }

        const port = process.env.PORT || 3000;
        const res = await fetch(`http://localhost:${port}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id, chat_id: resolvedChatId, media_path, media_type, caption, file_name }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return { content: [{ type: 'text', text: `Media sent successfully. ID: ${data.message_id}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}. Make sure the dashboard (npm start) is running.` }], isError: true };
      }
    }
  );

  server.tool(
    'forward_message',
    'Forward a previously received or sent message (including its media, if any) to another chat. Looks up the message by ID, reads text/caption/media_path from the database, and sends to the target. If the original had media that was downloaded, the media is re-sent; otherwise only the text is forwarded.' + restrictionNote,
    {
      source_message_id: z.string().describe('ID of the message to forward (the "id" field from list/read/search results)'),
      target_chat_id: z.string().describe('Target recipient: JID, plain phone number, or contact name'),
      account_id: z.string().optional().describe('Account to send from. Defaults to the source message account.'),
      additional_text: z.string().optional().describe('Optional prefix text added to caption/body'),
    },
    async ({ source_message_id, target_chat_id, account_id, additional_text }) => {
      try {
        const source = db.getMessageById(source_message_id);
        if (!source) {
          return { content: [{ type: 'text', text: `Message "${source_message_id}" not found.` }], isError: true };
        }
        const sendAccountId = account_id || source.account_id;
        assertAllowed(allowedAccounts, sendAccountId);

        // Resolve target
        const isJID = target_chat_id.includes('@s.whatsapp.net') || target_chat_id.includes('@g.us');
        const isPhone = /^\+?\d[\d\s\-()]{6,}$/.test(target_chat_id.trim());
        let resolvedChatId = target_chat_id;
        if (!isJID && !isPhone) {
          const contacts = db.getContacts({ search: target_chat_id, is_group: 0 });
          const needle = target_chat_id.toLowerCase().trim();
          const exact = contacts.filter(c => (c.name || '').toLowerCase().trim() === needle || (c.push_name || '').toLowerCase().trim() === needle);
          if (exact.length === 1) {
            resolvedChatId = resolveLidToJid(exact[0].id);
          } else {
            return { content: [{ type: 'text', text: `Ambiguous/unknown target "${target_chat_id}". Forward aborted.` }], isError: true };
          }
        }
        if (resolvedChatId.endsWith('@g.us') && !db.isGroupInteractable(resolvedChatId, sendAccountId)) {
          return { content: [{ type: 'text', text: `Access denied: interaction with this group is not allowed.` }], isError: true };
        }

        const port = process.env.PORT || 3000;
        const hasMedia = source.media_path && source.media_type;
        const body = hasMedia
          ? {
              account_id: sendAccountId,
              chat_id: resolvedChatId,
              media_path: source.media_path,
              media_type: source.media_type,
              caption: additional_text ? `${additional_text}\n\n${source.content || ''}`.trim() : (source.content || ''),
            }
          : {
              account_id: sendAccountId,
              chat_id: resolvedChatId,
              text: additional_text ? `${additional_text}\n\n${source.content}` : source.content,
            };

        const res = await fetch(`http://localhost:${port}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return { content: [{ type: 'text', text: `${hasMedia ? 'Media message' : 'Text message'} forwarded. ID: ${data.message_id}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

async function startMcpServer(allowedAccounts) {
  const server = createMcpServer(allowedAccounts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] WhatsApp MCP server running on stdio');
}

module.exports = { createMcpServer, startMcpServer };
