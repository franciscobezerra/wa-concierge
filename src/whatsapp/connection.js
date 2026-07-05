const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('../db/database');

const connections = new Map();
const retryCount = new Map();
const MAX_RETRIES = 10;
const BASE_DELAY = 3000;
const MAX_DELAY = 60000;
const MEDIA_DIR = path.join(__dirname, '..', '..', 'data', 'media');
const DOWNLOADABLE_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/aac': 'aac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'application/pdf': 'pdf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip', 'text/plain': 'txt', 'text/csv': 'csv',
};
const FALLBACK_EXT = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', sticker: 'webp' };
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
};
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac']);
const eventCallbacks = [];

// Resolve a LID to a phone-based JID using DB mappings + Baileys auth files
function resolveLidToJid(lid) {
  if (!lid || !lid.endsWith('@lid')) return lid;

  // 1. Check database mapping table first
  const dbResult = db.resolveLid(lid);
  if (dbResult) return dbResult;

  // 2. Fallback to Baileys auth mapping files
  const lidNumber = lid.split('@')[0];
  const authDir = path.join(__dirname, '..', '..', 'data', 'auth');
  try {
    const accounts = fs.readdirSync(authDir);
    for (const account of accounts) {
      const mapFile = path.join(authDir, account, `lid-mapping-${lidNumber}_reverse.json`);
      try {
        const phone = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
        if (phone) {
          const jid = `${phone}@s.whatsapp.net`;
          // Save to DB for future lookups
          db.saveLidMapping(lid, jid);
          return jid;
        }
      } catch {}
    }
  } catch {}
  return lid; // Return original if no mapping found
}

function onEvent(cb) {
  eventCallbacks.push(cb);
}

function emit(type, data) {
  const event = { type, data, timestamp: Date.now() };
  for (const cb of eventCallbacks) {
    try { cb(event); } catch (err) { console.error('[event] callback error:', err.message); }
  }
}

function extensionFromMedia(unwrappedMsg, mediaType) {
  const node = unwrappedMsg.imageMessage || unwrappedMsg.videoMessage || unwrappedMsg.audioMessage ||
    unwrappedMsg.pttMessage || unwrappedMsg.documentMessage || unwrappedMsg.stickerMessage;
  if (node?.fileName) {
    const ext = path.extname(node.fileName).slice(1).toLowerCase();
    if (ext && ext.length <= 5) return ext;
  }
  const mime = (node?.mimetype || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  return FALLBACK_EXT[mediaType] || 'bin';
}

async function downloadAndSaveMedia(msg, mediaType, accountId, sock) {
  if (!DOWNLOADABLE_TYPES.has(mediaType)) return null;
  try {
    let m = msg.message;
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    if (!m) return null;

    const ext = extensionFromMedia(m, mediaType);
    const accountDir = path.join(MEDIA_DIR, accountId);
    fs.mkdirSync(accountDir, { recursive: true });

    const safeId = msg.key.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(accountDir, `${safeId}.${ext}`);

    const node = m.imageMessage || m.videoMessage || m.audioMessage ||
      m.pttMessage || m.documentMessage || m.stickerMessage;
    const expectedSize = Number(node?.fileLength) || 0;

    if (fs.existsSync(filePath)) {
      const onDiskSize = fs.statSync(filePath).size;
      // Re-download if file is partial (smaller than expected). When fileLength is
      // unknown, accept any non-empty file as good enough.
      if (expectedSize > 0 && onDiskSize < expectedSize) {
        console.error(`[${accountId}] Re-baixando mídia parcial ${msg.key.id}: ${onDiskSize}/${expectedSize} bytes`);
        try { fs.unlinkSync(filePath); } catch {}
      } else if (onDiskSize > 0) {
        return filePath;
      }
    }

    const buffer = await downloadMediaMessage(
      { ...msg, message: m },
      'buffer',
      {},
      { reuploadRequest: sock.updateMediaMessage }
    );
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error(`[${accountId}] Download de mídia falhou (${msg.key.id}): ${err.message}`);
    return null;
  }
}

async function connectAccount(accountId, accountName, accountType) {
  if (connections.has(accountId) && connections.get(accountId).sock) {
    const existing = connections.get(accountId);
    if (existing.ready) {
      console.error(`[${accountId}] Already connected`);
      return existing;
    }
    // Close stale socket before reconnecting
    try { existing.sock.end(); } catch {}
    connections.delete(accountId);
  }

  const authDir = path.join(__dirname, '..', '..', 'data', 'auth', accountId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    console.error(`[${accountId}] Failed to fetch Baileys version, using default`);
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'warn' }),
    browser: [`WhatsApp MCP - ${accountName}`, 'Chrome', '1.0.0'],
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
    connectTimeoutMs: 20000,
  });

  const conn = { sock, accountId, accountName, accountType, ready: false, phone: null };
  connections.set(accountId, conn);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.error(`[${accountId}] QR code generated — scan with WhatsApp`);
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        emit('qr', { accountId, accountName, qr: qrDataUrl });
      } catch (err) {
        console.error(`[${accountId}] QR generation error:`, err.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';

      console.error(`[${accountId}] Connection closed. Status: ${statusCode}, reason: ${reason}`);
      conn.ready = false;
      db.saveAccount({ id: accountId, name: accountName, type: accountType, phone: conn.phone || '', connected: 0 });
      emit('connection', { accountId, accountName, status: 'disconnected', statusCode, reason });

      // Session is corrupt or invalid — clear auth and require new QR scan
      const needsReauth = [
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.multideviceMismatch,
      ].includes(statusCode);

      if (needsReauth) {
        console.error(`[${accountId}] Session invalid (${statusCode}). Clearing auth state...`);
        const authDir = path.join(__dirname, '..', '..', 'data', 'auth', accountId);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        connections.delete(accountId);
        retryCount.delete(accountId);
        emit('connection', { accountId, accountName, status: 'logged_out', reason: 'session_invalid' });
        return;
      }

      const attempts = (retryCount.get(accountId) || 0) + 1;
      retryCount.set(accountId, attempts);

      if (attempts > MAX_RETRIES) {
        console.error(`[${accountId}] Max retries (${MAX_RETRIES}) reached. Giving up.`);
        connections.delete(accountId);
        retryCount.delete(accountId);
        emit('connection', { accountId, accountName, status: 'failed', reason: 'max_retries' });
        return;
      }

      const delay = Math.min(BASE_DELAY * Math.pow(2, attempts - 1), MAX_DELAY);
      console.error(`[${accountId}] Reconnecting in ${delay / 1000}s (attempt ${attempts}/${MAX_RETRIES})...`);
      emit('connection', { accountId, accountName, status: 'reconnecting', attempt: attempts });
      setTimeout(() => connectAccount(accountId, accountName, accountType), delay);
    }

    if (connection === 'open') {
      console.error(`[${accountId}] Connected!`);
      conn.ready = true;
      retryCount.delete(accountId);
      const phone = sock.user?.id?.split(':')[0] || '';
      conn.phone = phone;
      db.saveAccount({ id: accountId, name: accountName, type: accountType, phone, connected: 1 });
      emit('connection', { accountId, accountName, status: 'connected', phone });

      // Resolve group contacts in background after connection stabilizes
      setTimeout(() => resolveGroupContacts(sock, accountId), 10000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    const isHistorySync = type !== 'notify';
    for (const msg of msgs) {
      try {
      if (!msg.message || !msg.key?.id || !msg.key?.remoteJid) continue;

      const chatId = msg.key.remoteJid;
      const isGroup = chatId.endsWith('@g.us');
      const isFromMe = msg.key.fromMe ? 1 : 0;
      const sender = isFromMe
        ? sock.user?.id || accountId
        : (isGroup ? msg.key.participant || chatId : chatId);

      let content = '';
      let mediaType = null;

      // Unwrap nested message containers (ephemeral, viewOnce, etc.)
      let m = msg.message;
      if (m.ephemeralMessage) m = m.ephemeralMessage.message;
      if (m.viewOnceMessage) m = m.viewOnceMessage.message;
      if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
      if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
      if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
      if (m.editedMessage) m = m.editedMessage.message;
      if (m.protocolMessage?.editedMessage) m = m.protocolMessage.editedMessage;

      if (m.conversation) content = m.conversation;
      else if (m.extendedTextMessage) content = m.extendedTextMessage.text || '';
      else if (m.imageMessage) { content = m.imageMessage.caption || '[Imagem]'; mediaType = 'image'; }
      else if (m.videoMessage) { content = m.videoMessage.caption || '[Video]'; mediaType = 'video'; }
      else if (m.audioMessage) { content = '[Audio]'; mediaType = 'audio'; }
      else if (m.pttMessage) { content = '[Audio]'; mediaType = 'audio'; }
      else if (m.documentMessage) { content = m.documentMessage.fileName || '[Documento]'; mediaType = 'document'; }
      else if (m.stickerMessage) { content = '[Sticker]'; mediaType = 'sticker'; }
      else if (m.contactMessage) { content = m.contactMessage.displayName || '[Contato]'; mediaType = 'contact'; }
      else if (m.contactsArrayMessage) { content = `[${m.contactsArrayMessage.contacts?.length || 0} Contatos]`; mediaType = 'contact'; }
      else if (m.locationMessage) { content = `[Localizacao: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}]`; mediaType = 'location'; }
      else if (m.liveLocationMessage) { content = '[Localizacao ao vivo]'; mediaType = 'location'; }
      else if (m.listMessage) { content = m.listMessage.title || m.listMessage.description || '[Lista]'; }
      else if (m.listResponseMessage) { content = m.listResponseMessage.title || '[Resposta de lista]'; }
      else if (m.buttonsMessage) { content = m.buttonsMessage.contentText || '[Botoes]'; }
      else if (m.buttonsResponseMessage) { content = m.buttonsResponseMessage.selectedDisplayText || '[Resposta de botao]'; }
      else if (m.templateMessage) { content = m.templateMessage.hydratedTemplate?.hydratedContentText || '[Template]'; }
      else if (m.templateButtonReplyMessage) { content = m.templateButtonReplyMessage.selectedDisplayText || '[Resposta template]'; }
      else if (m.reactionMessage) { content = m.reactionMessage.text || '[Reacao]'; mediaType = 'reaction'; }
      else if (m.pollCreationMessage || m.pollCreationMessageV3) { content = (m.pollCreationMessage || m.pollCreationMessageV3)?.name || '[Enquete]'; mediaType = 'poll'; }
      else if (m.pollUpdateMessage) { content = '[Voto em enquete]'; mediaType = 'poll'; }
      else if (m.orderMessage) { content = '[Pedido]'; mediaType = 'order'; }
      else if (m.productMessage) { content = m.productMessage.product?.productImage?.caption || '[Produto]'; mediaType = 'product'; }
      else if (m.protocolMessage) { content = null; } // system message, skip
      else if (m.senderKeyDistributionMessage) { content = null; } // internal, skip
      else { content = '[Mensagem nao suportada]'; }

      // Skip internal/system messages with no content
      if (content === null) continue;

      let groupName = null;
      // Only fetch group metadata for real-time messages (avoid flooding on history sync)
      if (isGroup && !isHistorySync) {
        try {
          const metadata = await sock.groupMetadata(chatId);
          groupName = metadata.subject;
          // Save participant contacts from group metadata
          for (const p of (metadata.participants || [])) {
            if (!p.id) continue;
            db.saveContact({
              id: p.id,
              account_id: accountId,
              phone: p.id.split('@')[0],
              name: null,
              push_name: p.notify || null,
              is_group: 0,
            });
            if (p.lid && p.id.endsWith('@s.whatsapp.net')) {
              db.saveLidMapping(p.lid, p.id);
            }
          }
        } catch { groupName = chatId; }
      }

      const senderName = msg.pushName || null;

      const msgData = {
        id: msg.key.id,
        account_id: accountId,
        chat_id: chatId,
        sender: sender || accountId,
        sender_name: senderName,
        content,
        media_type: mediaType,
        timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        is_from_me: isFromMe,
        is_group: isGroup ? 1 : 0,
        group_name: groupName,
      };

      // Save contacts and check group permissions
      if (isGroup) {
        db.saveContact({
          id: chatId,
          account_id: accountId,
          phone: chatId.split('@')[0],
          name: groupName || null,
          push_name: null,
          is_group: 1,
        });
        db.ensureGroupPermission(chatId, accountId);
        if (!db.isGroupReadable(chatId, accountId)) {
          continue; // Skip saving message — group blocked
        }
        if (!isFromMe && sender && sender !== chatId) {
          db.saveContact({
            id: sender,
            account_id: accountId,
            phone: sender.split('@')[0],
            name: null,
            push_name: senderName || null,
            is_group: 0,
          });
        }
      } else {
        db.saveContact({
          id: chatId,
          account_id: accountId,
          phone: chatId.split('@')[0],
          name: null,
          push_name: !isFromMe ? senderName : null,
          is_group: 0,
        });
      }

      db.saveMessage(msgData);
      if (!isHistorySync) {
        emit('message', msgData);
      }

      if (DOWNLOADABLE_TYPES.has(mediaType)) {
        downloadAndSaveMedia(msg, mediaType, accountId, sock).then(filePath => {
          if (filePath) db.updateMediaPath(msg.key.id, filePath);
        });
      }
      } catch (err) {
        // Skip messages that fail to save
      }
    }

    if (isHistorySync && msgs.length > 0) {
      console.log(`[${accountId}] History sync: ${msgs.length} messages saved`);
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      // Save the contact with its primary ID
      const contactId = contact.id;
      const contactLid = contact.lid;

      db.saveContact({
        id: contactId,
        account_id: accountId,
        phone: contactId.split('@')[0],
        name: contact.name || contact.notify || null,
        push_name: contact.notify || null,
        is_group: contactId.endsWith('@g.us') ? 1 : 0,
      });

      // If contact has both a phone-based JID and a LID, save the LID mapping
      // and also update the LID contact to point to the phone
      if (contactLid && contactId.endsWith('@s.whatsapp.net')) {
        const lidId = typeof contactLid === 'string' ? contactLid : contactLid.toString();
        db.saveLidMapping(lidId, contactId);
        // Merge: if LID contact exists with a name, transfer it to the JID contact
        const lidContact = db.getContactById(lidId);
        if (lidContact && (lidContact.name || lidContact.push_name)) {
          db.saveContact({
            id: contactId,
            account_id: accountId,
            phone: contactId.split('@')[0],
            name: lidContact.name || null,
            push_name: lidContact.push_name || contact.notify || null,
            is_group: 0,
          });
        }
      } else if (contactId.endsWith('@lid') && contact.name) {
        // LID-only contact — keep it, name will be useful for search
        // The LID mapping will be resolved when sending
      }
    }
  });

  // Handle history sync from WhatsApp (messages received while offline)
  sock.ev.on('messaging-history.set', ({ messages: msgs, chats, contacts, isLatest }) => {
    console.log(`[${accountId}] History sync received: ${msgs?.length || 0} messages, ${chats?.length || 0} chats, ${contacts?.length || 0} contacts`);

    if (contacts?.length) {
      for (const contact of contacts) {
        db.saveContact({
          id: contact.id,
          account_id: accountId,
          phone: contact.id.split('@')[0],
          name: contact.name || contact.notify || null,
          push_name: contact.notify || null,
          is_group: contact.id.endsWith('@g.us') ? 1 : 0,
        });

        // Capture LID mapping if available
        if (contact.lid && contact.id.endsWith('@s.whatsapp.net')) {
          const lidId = typeof contact.lid === 'string' ? contact.lid : contact.lid.toString();
          db.saveLidMapping(lidId, contact.id);
          // Transfer name from LID contact to JID contact
          const lidContact = db.getContactById(lidId);
          if (lidContact && (lidContact.name || lidContact.push_name)) {
            db.saveContact({
              id: contact.id,
              account_id: accountId,
              phone: contact.id.split('@')[0],
              name: lidContact.name || null,
              push_name: lidContact.push_name || contact.notify || null,
              is_group: 0,
            });
          }
        }
      }
    }

    if (msgs?.length) {
      let savedCount = 0;
      for (const msg of msgs) {
        try {
          if (!msg.message || !msg.key?.id || !msg.key?.remoteJid) continue;

          const chatId = msg.key.remoteJid;
          const isGroup = chatId.endsWith('@g.us');
          const isFromMe = msg.key.fromMe ? 1 : 0;
          const sender = isFromMe
            ? sock.user?.id || accountId
            : (isGroup ? msg.key.participant || chatId : chatId);

          let content = '';
          let mediaType = null;

          let m = msg.message;
          if (m.ephemeralMessage) m = m.ephemeralMessage.message;
          if (m.viewOnceMessage) m = m.viewOnceMessage.message;
          if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
          if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
          if (!m) continue;

          if (m.conversation) content = m.conversation;
          else if (m.extendedTextMessage) content = m.extendedTextMessage.text || '';
          else if (m.imageMessage) { content = m.imageMessage.caption || '[Imagem]'; mediaType = 'image'; }
          else if (m.videoMessage) { content = m.videoMessage.caption || '[Video]'; mediaType = 'video'; }
          else if (m.audioMessage || m.pttMessage) { content = '[Audio]'; mediaType = 'audio'; }
          else if (m.documentMessage) { content = m.documentMessage.fileName || '[Documento]'; mediaType = 'document'; }
          else if (m.stickerMessage) { content = '[Sticker]'; mediaType = 'sticker'; }
          else if (m.contactMessage) { content = m.contactMessage.displayName || '[Contato]'; mediaType = 'contact'; }
          else if (m.locationMessage) { content = `[Localizacao]`; mediaType = 'location'; }
          else if (m.reactionMessage) { content = m.reactionMessage.text || '[Reacao]'; mediaType = 'reaction'; }
          else if (m.protocolMessage || m.senderKeyDistributionMessage) continue;
          else content = '[Mensagem nao suportada]';

          if (!content) continue;

          db.saveMessage({
            id: msg.key.id,
            account_id: accountId,
            chat_id: chatId,
            sender: sender || accountId,
            sender_name: msg.pushName || null,
            content,
            media_type: mediaType,
          timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
          is_from_me: isFromMe,
          is_group: isGroup ? 1 : 0,
          group_name: null,
        });
          savedCount++;
          if (DOWNLOADABLE_TYPES.has(mediaType)) {
            downloadAndSaveMedia(msg, mediaType, accountId, sock).then(filePath => {
              if (filePath) db.updateMediaPath(msg.key.id, filePath);
            });
          }
        } catch (err) {
          // Skip messages that fail to save (e.g. null fields)
        }
      }
      if (savedCount > 0) {
        console.log(`[${accountId}] History sync: ${savedCount} messages saved`);
      }
    }
  });

  // Track message delivery and read receipts
  sock.ev.on('message-receipt.update', (updates) => {
    for (const update of updates) {
      const messageId = update.key?.id;
      if (!messageId) continue;

      let status = 'delivered';
      if (update.receipt?.type === 'read' || update.receipt?.type === 'read-self') {
        status = 'read';
      } else if (update.receipt?.type === 'played') {
        status = 'read'; // treat played audio as read
      }

      db.updateMessageStatus(messageId, status);
      emit('receipt', { messageId, status, accountId });
    }
  });

  return conn;
}

function detectMediaTypeFromPath(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'document';
}

function mimeFromPath(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

async function sendMessage(accountId, chatId, payload) {
  const conn = connections.get(accountId);
  if (!conn || !conn.ready) {
    throw new Error(`Account ${accountId} is not connected`);
  }

  if (!chatId.includes('@')) {
    chatId = chatId.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
  }

  // Reject LIDs — they don't work for sending messages
  if (chatId.endsWith('@lid')) {
    const resolved = resolveLidToJid(chatId);
    if (resolved.endsWith('@lid')) {
      throw new Error(`Cannot send to LID "${chatId}". This is an internal WhatsApp identifier, not a phone number. Please provide the phone number directly.`);
    }
    chatId = resolved;
  }

  const opts = typeof payload === 'string' ? { text: payload } : (payload || {});
  const { text, media_path, media_type, caption, mime_type, file_name } = opts;

  let waMessage;
  let contentForDb;
  let mediaTypeForDb = null;
  let archivedPath = null;

  if (media_path) {
    const isUrl = /^https?:\/\//.test(media_path);
    if (!isUrl && !fs.existsSync(media_path)) {
      throw new Error(`Media file not found: ${media_path}`);
    }
    const source = isUrl ? { url: media_path } : fs.readFileSync(media_path);
    const detectedType = media_type || detectMediaTypeFromPath(isUrl ? new URL(media_path).pathname : media_path);
    const effectiveCaption = caption ?? text ?? '';

    if (detectedType === 'image') {
      waMessage = { image: source, caption: effectiveCaption };
      mediaTypeForDb = 'image';
    } else if (detectedType === 'video') {
      waMessage = { video: source, caption: effectiveCaption };
      mediaTypeForDb = 'video';
    } else if (detectedType === 'audio') {
      waMessage = { audio: source, mimetype: mime_type || (isUrl ? 'audio/mp4' : mimeFromPath(media_path)) };
      mediaTypeForDb = 'audio';
    } else if (detectedType === 'voice' || detectedType === 'ptt') {
      waMessage = { audio: source, mimetype: 'audio/ogg; codecs=opus', ptt: true };
      mediaTypeForDb = 'audio';
    } else if (detectedType === 'document') {
      const fname = file_name || path.basename(isUrl ? new URL(media_path).pathname : media_path);
      waMessage = {
        document: source,
        mimetype: mime_type || mimeFromPath(isUrl ? fname : media_path),
        fileName: fname,
        caption: effectiveCaption,
      };
      mediaTypeForDb = 'document';
    } else if (detectedType === 'sticker') {
      waMessage = { sticker: source };
      mediaTypeForDb = 'sticker';
    } else {
      throw new Error(`Unsupported media_type: ${detectedType}. Use image, video, audio, voice, document, or sticker.`);
    }
    contentForDb = effectiveCaption || `[${mediaTypeForDb}]`;
  } else {
    if (!text) throw new Error('text or media_path is required');
    waMessage = { text };
    contentForDb = text;
  }

  const result = await conn.sock.sendMessage(chatId, waMessage);

  // Archive local media so dashboard/forward can reference it
  if (media_path && !(/^https?:\/\//.test(media_path))) {
    try {
      const ext = path.extname(media_path) || '.bin';
      const accountDir = path.join(MEDIA_DIR, accountId);
      fs.mkdirSync(accountDir, { recursive: true });
      const safeId = result.key.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      archivedPath = path.join(accountDir, `${safeId}${ext}`);
      if (!fs.existsSync(archivedPath)) {
        fs.copyFileSync(media_path, archivedPath);
      }
    } catch (err) {
      console.error(`[${accountId}] Falha ao arquivar mídia enviada: ${err.message}`);
      archivedPath = null;
    }
  }

  const msgData = {
    id: result.key.id,
    account_id: accountId,
    chat_id: chatId,
    sender: conn.sock.user?.id || accountId,
    sender_name: conn.accountName,
    content: contentForDb,
    media_type: mediaTypeForDb,
    media_path: archivedPath,
    timestamp: Math.floor(Date.now() / 1000),
    is_from_me: 1,
    is_group: chatId.endsWith('@g.us') ? 1 : 0,
    group_name: null,
  };

  db.saveMessage(msgData);
  emit('message', msgData);

  return result;
}

function getConnection(accountId) {
  return connections.get(accountId);
}

function getAllConnections() {
  return Array.from(connections.entries()).map(([id, conn]) => ({
    id,
    name: conn.accountName,
    type: conn.accountType,
    ready: conn.ready,
    phone: conn.phone,
  }));
}

// Resolve contacts from group metadata — extracts participant names and LID mappings
async function resolveGroupContacts(sock, accountId) {
  const groups = db.getContacts({ account_id: accountId, is_group: 1 });
  console.error(`[${accountId}] Resolving contacts from ${groups.length} groups...`);

  let resolved = 0;
  let errors = 0;

  for (const group of groups) {
    try {
      const metadata = await sock.groupMetadata(group.id);

      // Update group name
      if (metadata.subject) {
        db.saveContact({
          id: group.id,
          account_id: accountId,
          phone: group.id.split('@')[0],
          name: metadata.subject,
          push_name: null,
          is_group: 1,
        });
      }

      // Process participants
      for (const participant of (metadata.participants || [])) {
        if (!participant.id) continue;

        const pId = participant.id;
        const pName = participant.notify || null;

        db.saveContact({
          id: pId,
          account_id: accountId,
          phone: pId.split('@')[0],
          name: null,
          push_name: pName,
          is_group: 0,
        });

        // If participant has a LID, try to capture mapping
        if (participant.lid && pId.endsWith('@s.whatsapp.net')) {
          db.saveLidMapping(participant.lid, pId);
        }

        resolved++;
      }

      // Rate limit: 500ms between groups to avoid throttling
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      errors++;
      // Skip groups that fail (e.g., left the group)
    }
  }

  console.error(`[${accountId}] Contact resolution done: ${resolved} contacts from groups (${errors} errors)`);
  return { resolved, errors, groups: groups.length };
}

async function disconnectAccount(accountId) {
  const conn = connections.get(accountId);
  if (conn?.sock) {
    try { await conn.sock.logout(); } catch {}
    connections.delete(accountId);
    emit('connection', { accountId, status: 'disconnected' });
  }
}

module.exports = {
  connectAccount,
  sendMessage,
  getConnection,
  getAllConnections,
  disconnectAccount,
  onEvent,
  resolveLidToJid,
  resolveGroupContacts,
};
