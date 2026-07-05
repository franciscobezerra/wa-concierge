const express = require('express');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const multer = require('multer');
const db = require('../db/database');
const whatsapp = require('../whatsapp/connection');

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

const { config, CONFIG_PATH } = require('../config');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || config.dashboard_password;
if (!DASHBOARD_PASSWORD) {
  console.error(`[WEB] No dashboard password configured. Run: node scripts/setup.js (expected config at ${CONFIG_PATH})`);
  process.exit(1);
}
const activeSessions = new Set();

const UPLOAD_TMP_DIR = path.join(__dirname, '..', '..', 'data', 'tmp', 'uploads');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeName}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Auth: login endpoint
app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.add(token);
    res.cookie('wmcp_session', token, { httpOnly: true, sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

app.post('/auth/logout', (req, res) => {
  const token = parseCookie(req.headers.cookie, 'wmcp_session');
  if (token) activeSessions.delete(token);
  res.clearCookie('wmcp_session');
  res.json({ ok: true });
});

// Serve login page without auth
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Auth middleware — protect everything except /auth/* and /login.html
function authMiddleware(req, res, next) {
  const token = parseCookie(req.headers.cookie, 'wmcp_session');
  if (token && activeSessions.has(token)) return next();
  // API requests get 401
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Browser requests redirect to login
  res.redirect('/login.html');
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(name + '='));
  return match ? match.split('=')[1].trim() : null;
}

app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

// ---- Event bridge: WhatsApp -> Socket.IO ----
function setupEventBridge() {
  whatsapp.onEvent((event) => {
    io.emit('wa:event', event);
  });
}

// ---- REST API ----

app.get('/api/accounts', (req, res) => {
  const accounts = db.getAccounts();
  const live = whatsapp.getAllConnections();
  const result = accounts.map(a => {
    const l = live.find(c => c.id === a.id);
    return { ...a, live_connected: l?.ready || false, phone: l?.phone || a.phone };
  });
  res.json(result);
});

app.post('/api/accounts', async (req, res) => {
  const { id, name, type } = req.body;
  if (!id || !name || !['personal', 'business'].includes(type)) {
    return res.status(400).json({ error: 'id, name, and type (personal/business) are required' });
  }
  db.saveAccount({ id, name, type, phone: '', connected: 0 });
  try {
    await whatsapp.connectAccount(id, name, type);
    res.json({ ok: true, message: 'Account created. Check for QR code.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/connect', async (req, res) => {
  const acc = db.getAccounts().find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  try {
    await whatsapp.connectAccount(acc.id, acc.name, acc.type);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/disconnect', async (req, res) => {
  try {
    await whatsapp.disconnectAccount(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    await whatsapp.disconnectAccount(req.params.id);
    const d = db.getDb();
    d.prepare('DELETE FROM messages WHERE account_id = ?').run(req.params.id);
    d.prepare('DELETE FROM contacts WHERE account_id = ?').run(req.params.id);
    d.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
    // Remove account from AI profiles
    db.removeAccountFromProfiles(req.params.id);
    // Remove auth folder
    const fs = require('fs');
    const authDir = path.join(__dirname, '..', '..', 'data', 'auth', req.params.id);
    fs.rmSync(authDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats', (req, res) => {
  const { account_id, limit } = req.query;
  const chats = db.getChats({ account_id, limit: parseInt(limit) || 50 });
  res.json(chats);
});

app.get('/api/messages', (req, res) => {
  const { account_id, chat_id, limit, before_timestamp, search } = req.query;
  const messages = db.getMessages({
    account_id,
    chat_id,
    limit: parseInt(limit) || 50,
    before_timestamp: before_timestamp ? parseInt(before_timestamp) : undefined,
    search,
  });
  res.json(messages);
});

app.post('/api/send', upload.single('file'), async (req, res) => {
  const { account_id, chat_id, text, media_type, caption, mime_type, file_name } = req.body;
  let { media_path } = req.body;
  const uploadedFile = req.file;

  // Uploaded file (multipart) takes precedence over media_path. Use original
  // filename as fileName for documents and the multer-detected mimetype.
  let effectiveMediaType = media_type;
  let effectiveMimeType = mime_type;
  let effectiveFileName = file_name;
  if (uploadedFile) {
    media_path = uploadedFile.path;
    effectiveMimeType = effectiveMimeType || uploadedFile.mimetype;
    effectiveFileName = effectiveFileName || uploadedFile.originalname;
  }

  if (!account_id || !chat_id) {
    if (uploadedFile) try { fs.unlinkSync(uploadedFile.path); } catch {}
    return res.status(400).json({ error: 'account_id and chat_id are required' });
  }
  if (!text && !media_path) {
    return res.status(400).json({ error: 'text or media_path/file is required' });
  }

  try {
    const result = await whatsapp.sendMessage(account_id, chat_id, {
      text, media_path, media_type: effectiveMediaType, caption,
      mime_type: effectiveMimeType, file_name: effectiveFileName,
    });
    res.json({ ok: true, message_id: result.key.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // sendMessage already archived a copy to data/media/<account>/. Always clean
    // up the temp upload regardless of success/failure.
    if (uploadedFile) try { fs.unlinkSync(uploadedFile.path); } catch {}
  }
});

app.get('/api/media/:messageId', (req, res) => {
  const msg = db.getMessageById(req.params.messageId);
  if (!msg || !msg.media_path) {
    return res.status(404).json({ error: 'Media not found for this message' });
  }
  const fs = require('fs');
  if (!fs.existsSync(msg.media_path)) {
    return res.status(404).json({ error: 'Media file missing on disk' });
  }
  const inline = req.query.download !== '1';
  const baseName = path.basename(msg.media_path);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${baseName}"`);
  res.sendFile(msg.media_path);
});

const DOWNLOADABLE_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

app.post('/api/media/:messageId/redownload', async (req, res) => {
  const fs = require('fs');
  const msg = db.getMessageById(req.params.messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!DOWNLOADABLE_MEDIA_TYPES.has(msg.media_type)) {
    return res.status(400).json({ error: `Message media_type '${msg.media_type}' is not downloadable` });
  }

  const conn = whatsapp.getConnection(msg.account_id);
  if (!conn?.sock || !conn.ready) {
    return res.status(503).json({ error: `Account '${msg.account_id}' is not connected` });
  }

  let deletedSize = null;
  if (msg.media_path && fs.existsSync(msg.media_path)) {
    try {
      deletedSize = fs.statSync(msg.media_path).size;
      fs.unlinkSync(msg.media_path);
    } catch (err) {
      return res.status(500).json({ error: `Could not delete partial file: ${err.message}` });
    }
  }
  db.updateMediaPath(msg.id, null);

  // fetchMessageHistory returns messages OLDER than the boundary key, exclusive.
  // Use a slightly newer message in the same chat as the boundary so the target
  // is included in the resync. Fall back to the target itself if no newer
  // message exists locally — caller can retry once the chat receives traffic.
  const boundary = db.getNextNewerMessageInChat(msg.account_id, msg.chat_id, msg.timestamp) || msg;

  try {
    await conn.sock.fetchMessageHistory(
      20,
      { remoteJid: boundary.chat_id, fromMe: !!boundary.is_from_me, id: boundary.id },
      Number(boundary.timestamp) * 1000
    );
  } catch (err) {
    return res.status(500).json({ error: `History fetch failed: ${err.message}` });
  }

  res.json({
    status: 'requested',
    message_id: msg.id,
    deleted_partial_bytes: deletedSize,
    boundary_message_id: boundary.id,
    note: 'WhatsApp foi solicitado a re-sincronizar o histórico. O download acontece de forma assíncrona quando a mensagem chegar pelo handler. Aguarde alguns segundos e tente GET /api/media/' + msg.id,
  });
});

app.get('/api/contacts', (req, res) => {
  const { account_id, search, is_group, limit } = req.query;
  const contacts = db.getContacts({ account_id, search, is_group: is_group !== undefined ? parseInt(is_group) : undefined, limit: parseInt(limit) || undefined });
  res.json(contacts);
});

app.put('/api/contacts/:id', (req, res) => {
  const { account_id, name } = req.body;
  if (!account_id || !name) return res.status(400).json({ error: 'account_id and name are required' });
  const d = db.getDb();
  const existing = d.prepare('SELECT * FROM contacts WHERE id = ? AND account_id = ?').get(req.params.id, account_id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  d.prepare('UPDATE contacts SET name = ?, updated_at = datetime(\'now\') WHERE id = ? AND account_id = ?').run(name, req.params.id, account_id);
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', (req, res) => {
  const { account_id } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id is required' });
  db.getDb().prepare('DELETE FROM contacts WHERE id = ? AND account_id = ?').run(req.params.id, account_id);
  res.json({ ok: true });
});

// ---- AI Profiles API ----
app.get('/api/ai-profiles', (req, res) => {
  res.json(db.getAiProfiles());
});

app.post('/api/ai-profiles', (req, res) => {
  const { name, allowed_accounts } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!Array.isArray(allowed_accounts)) {
    return res.status(400).json({ error: 'allowed_accounts must be an array' });
  }
  const profile = db.createAiProfile({ name: name.trim(), allowed_accounts });
  res.status(201).json(profile);
});

app.get('/api/ai-profiles/:id', (req, res) => {
  const profile = db.getAiProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

app.put('/api/ai-profiles/:id', (req, res) => {
  const { name, allowed_accounts } = req.body;
  const profile = db.updateAiProfile(req.params.id, { name: name?.trim(), allowed_accounts });
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

app.delete('/api/ai-profiles/:id', (req, res) => {
  db.deleteAiProfile(req.params.id);
  res.json({ ok: true });
});

app.post('/api/ai-profiles/:id/regenerate-key', (req, res) => {
  const profile = db.regenerateAiProfileKey(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

app.get('/api/stats', (req, res) => {
  const d = db.getDb();
  const totalMessages = d.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const totalContacts = d.prepare('SELECT COUNT(*) as count FROM contacts').get().count;
  const totalChats = d.prepare('SELECT COUNT(DISTINCT chat_id) as count FROM messages').get().count;
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const todayMessages = d.prepare('SELECT COUNT(*) as count FROM messages WHERE timestamp > ?').get(todayStart).count;
  const accounts = db.getAccounts();
  const live = whatsapp.getAllConnections();

  const aiProfiles = db.getAiProfiles();
  res.json({
    total_messages: totalMessages,
    total_contacts: totalContacts,
    total_chats: totalChats,
    today_messages: todayMessages,
    accounts_total: accounts.length,
    accounts_connected: live.filter(l => l.ready).length,
    ai_profiles_total: aiProfiles.length,
  });
});

// ---- Scheduled Messages ----
app.get('/api/scheduled', (req, res) => {
  const { account_id, status, limit } = req.query;
  const messages = db.getScheduledMessages({
    account_id: account_id || undefined,
    status: status || undefined,
    limit: parseInt(limit) || 50,
  });
  res.json(messages);
});

app.post('/api/scheduled', (req, res) => {
  const { account_id, chat_id, contact_name, text, scheduled_at } = req.body;
  if (!account_id || !chat_id || !text || !scheduled_at) {
    return res.status(400).json({ error: 'account_id, chat_id, text, and scheduled_at are required' });
  }
  const ts = typeof scheduled_at === 'number' ? scheduled_at : Math.floor(new Date(scheduled_at).getTime() / 1000);
  if (ts <= Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: 'scheduled_at must be in the future' });
  }
  const msg = db.createScheduledMessage({ account_id, chat_id, contact_name, text, scheduled_at: ts });
  res.status(201).json(msg);
});

app.delete('/api/scheduled/:id', (req, res) => {
  const result = db.cancelScheduledMessage(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found or not pending' });
  res.json({ ok: true });
});

// ---- Global Search ----
app.get('/api/search', (req, res) => {
  const { q, account_id, limit, offset } = req.query;
  if (!q || !q.trim()) return res.json([]);
  const results = db.searchAllMessages({
    search: q.trim(),
    account_id: account_id || undefined,
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0,
  });
  res.json(results);
});

// ---- Contact Resolution ----
app.post('/api/accounts/:id/resolve-contacts', async (req, res) => {
  const conn = whatsapp.getConnection(req.params.id);
  if (!conn || !conn.ready) {
    return res.status(400).json({ error: 'Account not connected' });
  }
  try {
    const result = await whatsapp.resolveGroupContacts(conn.sock, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Group Permissions ----
app.get('/api/groups', (req, res) => {
  const { account_id } = req.query;
  const groups = db.getGroupsWithPermissions(account_id || null);
  res.json(groups);
});

app.put('/api/group-permissions', (req, res) => {
  const { group_id, account_id, can_read, can_interact } = req.body;
  if (!group_id || !account_id) {
    return res.status(400).json({ error: 'group_id and account_id are required' });
  }
  db.setGroupPermission(group_id, account_id, can_read ? 1 : 0, can_interact ? 1 : 0);
  res.json({ ok: true });
});

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Socket.IO ----
io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie;
  const token = parseCookie(cookie, 'wmcp_session');
  if (token && activeSessions.has(token)) return next();
  next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  console.log('[WEB] Client connected');
  socket.on('disconnect', () => console.log('[WEB] Client disconnected'));
});

function start(port = 3000) {
  setupEventBridge();
  server.listen(port, () => {
    console.log(`\n  🌐 WhatsApp MCP Dashboard: http://localhost:${port}\n`);
  });
}

module.exports = { app, server, io, start };
