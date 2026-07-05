const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'messages.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('personal', 'business')),
      phone TEXT,
      connected INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT,
      content TEXT,
      media_type TEXT,
      timestamp INTEGER NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      is_group INTEGER DEFAULT 0,
      group_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      phone TEXT,
      name TEXT,
      push_name TEXT,
      is_group INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(account_id, chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);

    CREATE TABLE IF NOT EXISTS ai_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      allowed_accounts TEXT NOT NULL DEFAULT '[]',
      api_key TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_profiles_api_key ON ai_profiles(api_key);

    CREATE TABLE IF NOT EXISTS lid_mappings (
      lid TEXT PRIMARY KEY,
      jid TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      contact_name TEXT,
      text TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      sent_at INTEGER,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(status, scheduled_at);

    CREATE TABLE IF NOT EXISTS group_permissions (
      group_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      can_read INTEGER DEFAULT 1,
      can_interact INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, account_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
  `);

  // Migration: add status column to messages
  const cols = db.pragma('table_info(messages)');
  if (!cols.find(c => c.name === 'status')) {
    db.exec("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'");
  }
  // Migration: add media_path column to messages
  if (!cols.find(c => c.name === 'media_path')) {
    db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT');
  }
}

function saveMessage(msg) {
  const data = {
    ...msg,
    media_path: msg.media_path || null,
    status: msg.status || (msg.is_from_me ? 'sent' : 'received'),
  };
  const stmt = getDb().prepare(`
    INSERT INTO messages (id, account_id, chat_id, sender, sender_name, content, media_type, media_path, timestamp, is_from_me, is_group, group_name, status)
    VALUES (@id, @account_id, @chat_id, @sender, @sender_name, @content, @media_type, @media_path, @timestamp, @is_from_me, @is_group, @group_name, @status)
    ON CONFLICT(id) DO UPDATE SET
      chat_id = excluded.chat_id,
      sender = excluded.sender,
      sender_name = COALESCE(excluded.sender_name, messages.sender_name),
      content = excluded.content,
      media_type = COALESCE(excluded.media_type, messages.media_type),
      media_path = COALESCE(messages.media_path, excluded.media_path),
      timestamp = excluded.timestamp,
      is_from_me = excluded.is_from_me,
      is_group = excluded.is_group,
      group_name = COALESCE(excluded.group_name, messages.group_name)
  `);
  stmt.run(data);
}

function updateMediaPath(messageId, mediaPath) {
  getDb().prepare('UPDATE messages SET media_path = ? WHERE id = ?').run(mediaPath, messageId);
}

function getMessageById(messageId) {
  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}

function getNextNewerMessageInChat(accountId, chatId, timestamp) {
  return getDb().prepare(`
    SELECT * FROM messages
    WHERE account_id = ? AND chat_id = ? AND timestamp > ?
    ORDER BY timestamp ASC
    LIMIT 1
  `).get(accountId, chatId, timestamp);
}

function updateMessageStatus(messageId, status) {
  // Only upgrade: sent -> delivered -> read (never downgrade)
  const validUpgrade = {
    sent: ['delivered', 'read'],
    delivered: ['read'],
  };
  getDb().prepare(`
    UPDATE messages SET status = @status
    WHERE id = @id AND is_from_me = 1
      AND (status IS NULL OR status = 'sent' OR (status = 'delivered' AND @status = 'read'))
  `).run({ id: messageId, status });
}

function getContactById(id) {
  return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function saveLidMapping(lid, jid) {
  getDb().prepare(`
    INSERT OR REPLACE INTO lid_mappings (lid, jid, updated_at)
    VALUES (?, ?, datetime('now'))
  `).run(lid, jid);
}

function resolveLid(lid) {
  const row = getDb().prepare('SELECT jid FROM lid_mappings WHERE lid = ?').get(lid);
  return row ? row.jid : null;
}

function saveContact(contact) {
  // Use UPSERT to preserve existing name/push_name when new values are null
  const stmt = getDb().prepare(`
    INSERT INTO contacts (id, account_id, phone, name, push_name, is_group, updated_at)
    VALUES (@id, @account_id, @phone, @name, @push_name, @is_group, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(@phone, phone),
      name = COALESCE(@name, name),
      push_name = COALESCE(@push_name, push_name),
      is_group = @is_group,
      updated_at = datetime('now')
  `);
  stmt.run(contact);
}

function saveAccount(account) {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO accounts (id, name, type, phone, connected)
    VALUES (@id, @name, @type, @phone, @connected)
  `);
  stmt.run(account);
}

function getMessages({ account_id, chat_id, limit = 50, before_timestamp, search }) {
  let query = 'SELECT * FROM messages WHERE 1=1';
  const params = {};

  if (account_id) {
    query += ' AND account_id = @account_id';
    params.account_id = account_id;
  }
  if (chat_id) {
    query += ' AND chat_id = @chat_id';
    params.chat_id = chat_id;
  }
  if (before_timestamp) {
    query += ' AND timestamp < @before_timestamp';
    params.before_timestamp = before_timestamp;
  }
  if (search) {
    query += ' AND content LIKE @search';
    params.search = `%${search}%`;
  }

  query += ' ORDER BY timestamp DESC LIMIT @limit';
  params.limit = limit;

  return getDb().prepare(query).all(params);
}

function getChats({ account_id, limit = 50 }) {
  const params = {};
  let where = '';
  if (account_id) {
    where = 'WHERE m.account_id = @account_id';
    params.account_id = account_id;
  }
  params.limit = limit;

  const query = `
    SELECT m.chat_id, m.account_id,
      COALESCE(c.name, c.push_name, m.chat_id) as chat_name,
      m.is_group,
      m.group_name,
      a.type as account_type,
      a.name as account_name,
      MAX(m.timestamp) as last_message_time,
      (SELECT content FROM messages m2 WHERE m2.chat_id = m.chat_id AND m2.account_id = m.account_id ORDER BY timestamp DESC LIMIT 1) as last_message,
      COUNT(*) as message_count
    FROM messages m
    LEFT JOIN contacts c ON c.id = m.chat_id AND c.account_id = m.account_id
    LEFT JOIN accounts a ON a.id = m.account_id
    ${where}
    GROUP BY m.chat_id, m.account_id
    ORDER BY last_message_time DESC
    LIMIT @limit
  `;
  return getDb().prepare(query).all(params);
}

function getAccounts() {
  return getDb().prepare('SELECT * FROM accounts').all();
}

function getContacts({ account_id, search, is_group, limit }) {
  let query = 'SELECT * FROM contacts WHERE 1=1';
  const params = {};
  if (account_id) {
    query += ' AND account_id = @account_id';
    params.account_id = account_id;
  }
  if (search) {
    query += ' AND (name LIKE @search OR push_name LIKE @search OR phone LIKE @search OR id LIKE @search)';
    params.search = `%${search}%`;
  }
  if (is_group !== undefined && is_group !== null) {
    query += ' AND is_group = @is_group';
    params.is_group = is_group;
  }
  query += ' ORDER BY name';
  if (limit) {
    query += ' LIMIT @limit';
    params.limit = limit;
  }
  return getDb().prepare(query).all(params);
}

// ---- Scheduled Messages ----
function createScheduledMessage({ account_id, chat_id, contact_name, text, scheduled_at }) {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO scheduled_messages (id, account_id, chat_id, contact_name, text, scheduled_at)
    VALUES (@id, @account_id, @chat_id, @contact_name, @text, @scheduled_at)
  `).run({ id, account_id, chat_id, contact_name: contact_name || null, text, scheduled_at });
  return getDb().prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
}

function getPendingScheduledMessages(beforeTimestamp) {
  return getDb().prepare(`
    SELECT * FROM scheduled_messages
    WHERE status = 'pending' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
  `).all(beforeTimestamp);
}

function updateScheduledMessageStatus(id, status, error) {
  const sentAt = status === 'sent' ? Math.floor(Date.now() / 1000) : null;
  getDb().prepare(`
    UPDATE scheduled_messages SET status = ?, error = ?, sent_at = ? WHERE id = ?
  `).run(status, error || null, sentAt, id);
}

function getScheduledMessages({ account_id, status, limit = 50 }) {
  let query = 'SELECT * FROM scheduled_messages WHERE 1=1';
  const params = {};
  if (account_id) {
    query += ' AND account_id = @account_id';
    params.account_id = account_id;
  }
  if (status) {
    query += ' AND status = @status';
    params.status = status;
  }
  query += ' ORDER BY scheduled_at DESC LIMIT @limit';
  params.limit = limit;
  return getDb().prepare(query).all(params);
}

function cancelScheduledMessage(id) {
  return getDb().prepare("UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
}

// ---- Global Search ----
function searchAllMessages({ search, account_id, limit = 50, offset = 0 }) {
  let query = `
    SELECT m.*,
      COALESCE(c.name, c.push_name, m.chat_id) as chat_name,
      a.name as account_name,
      a.type as account_type
    FROM messages m
    LEFT JOIN contacts c ON c.id = m.chat_id
    LEFT JOIN accounts a ON a.id = m.account_id
    WHERE m.content LIKE @search
  `;
  const params = { search: `%${search}%`, limit, offset };

  if (account_id) {
    query += ' AND m.account_id = @account_id';
    params.account_id = account_id;
  }

  query += ' ORDER BY m.timestamp DESC LIMIT @limit OFFSET @offset';
  return getDb().prepare(query).all(params);
}

// ---- Group Permissions ----
function getGroupPermission(groupId, accountId) {
  return getDb().prepare('SELECT * FROM group_permissions WHERE group_id = ? AND account_id = ?').get(groupId, accountId);
}

function setGroupPermission(groupId, accountId, canRead, canInteract) {
  getDb().prepare(`
    INSERT INTO group_permissions (group_id, account_id, can_read, can_interact, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(group_id, account_id) DO UPDATE SET
      can_read = ?,
      can_interact = ?,
      updated_at = datetime('now')
  `).run(groupId, accountId, canRead, canInteract, canRead, canInteract);
}

function getGroupPermissions(accountId) {
  if (accountId) {
    return getDb().prepare(`
      SELECT gp.*, COALESCE(c.name, c.push_name, gp.group_id) as group_name
      FROM group_permissions gp
      LEFT JOIN contacts c ON c.id = gp.group_id
      WHERE gp.account_id = ?
      ORDER BY group_name
    `).all(accountId);
  }
  return getDb().prepare(`
    SELECT gp.*, COALESCE(c.name, c.push_name, gp.group_id) as group_name
    FROM group_permissions gp
    LEFT JOIN contacts c ON c.id = gp.group_id
    ORDER BY gp.account_id, group_name
  `).all();
}

function isGroupReadable(groupId, accountId) {
  const perm = getDb().prepare('SELECT can_read FROM group_permissions WHERE group_id = ? AND account_id = ?').get(groupId, accountId);
  return perm ? perm.can_read === 1 : true; // default: allowed
}

function isGroupInteractable(groupId, accountId) {
  const perm = getDb().prepare('SELECT can_interact FROM group_permissions WHERE group_id = ? AND account_id = ?').get(groupId, accountId);
  return perm ? perm.can_interact === 1 : true; // default: allowed
}

function ensureGroupPermission(groupId, accountId) {
  // Auto-create permission entry for new groups (default: allowed)
  const existing = getDb().prepare('SELECT 1 FROM group_permissions WHERE group_id = ? AND account_id = ?').get(groupId, accountId);
  if (!existing) {
    getDb().prepare(`
      INSERT INTO group_permissions (group_id, account_id, can_read, can_interact, updated_at)
      VALUES (?, ?, 1, 1, datetime('now'))
    `).run(groupId, accountId);
  }
}

function getGroupsWithPermissions(accountId) {
  // Returns all known groups for an account with their permissions
  const query = `
    SELECT c.id as group_id, c.account_id,
      COALESCE(c.name, c.push_name, c.id) as group_name,
      COALESCE(gp.can_read, 1) as can_read,
      COALESCE(gp.can_interact, 1) as can_interact
    FROM contacts c
    LEFT JOIN group_permissions gp ON gp.group_id = c.id AND gp.account_id = c.account_id
    WHERE c.is_group = 1
    ${accountId ? 'AND c.account_id = ?' : ''}
    ORDER BY group_name
  `;
  return accountId ? getDb().prepare(query).all(accountId) : getDb().prepare(query).all();
}

// ---- AI Profiles ----
function createAiProfile({ name, allowed_accounts }) {
  const id = crypto.randomUUID();
  const api_key = 'wmcp_' + crypto.randomBytes(32).toString('hex');
  const stmt = getDb().prepare(`
    INSERT INTO ai_profiles (id, name, allowed_accounts, api_key)
    VALUES (@id, @name, @allowed_accounts, @api_key)
  `);
  stmt.run({ id, name, allowed_accounts: JSON.stringify(allowed_accounts || []), api_key });
  return getAiProfile(id);
}

function getAiProfiles() {
  const rows = getDb().prepare('SELECT * FROM ai_profiles ORDER BY created_at DESC').all();
  return rows.map(r => ({ ...r, allowed_accounts: JSON.parse(r.allowed_accounts) }));
}

function getAiProfile(id) {
  const row = getDb().prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, allowed_accounts: JSON.parse(row.allowed_accounts) };
}

function getAiProfileByApiKey(apiKey) {
  const row = getDb().prepare('SELECT * FROM ai_profiles WHERE api_key = ?').get(apiKey);
  if (!row) return null;
  return { ...row, allowed_accounts: JSON.parse(row.allowed_accounts) };
}

function updateAiProfile(id, { name, allowed_accounts }) {
  const existing = getAiProfile(id);
  if (!existing) return null;
  const stmt = getDb().prepare(`
    UPDATE ai_profiles SET name = @name, allowed_accounts = @allowed_accounts WHERE id = @id
  `);
  stmt.run({
    id,
    name: name !== undefined ? name : existing.name,
    allowed_accounts: JSON.stringify(allowed_accounts !== undefined ? allowed_accounts : existing.allowed_accounts),
  });
  return getAiProfile(id);
}

function regenerateAiProfileKey(id) {
  const newKey = 'wmcp_' + crypto.randomBytes(32).toString('hex');
  const result = getDb().prepare('UPDATE ai_profiles SET api_key = ? WHERE id = ?').run(newKey, id);
  if (result.changes === 0) return null;
  return getAiProfile(id);
}

function deleteAiProfile(id) {
  return getDb().prepare('DELETE FROM ai_profiles WHERE id = ?').run(id);
}

function removeAccountFromProfiles(accountId) {
  const profiles = getAiProfiles();
  for (const profile of profiles) {
    if (profile.allowed_accounts.includes(accountId)) {
      const updated = profile.allowed_accounts.filter(a => a !== accountId);
      updateAiProfile(profile.id, { allowed_accounts: updated });
    }
  }
}

module.exports = {
  getDb,
  saveMessage,
  updateMediaPath,
  getMessageById,
  getNextNewerMessageInChat,
  updateMessageStatus,
  saveContact,
  getContactById,
  saveLidMapping,
  resolveLid,
  saveAccount,
  getMessages,
  getChats,
  getAccounts,
  getContacts,
  createAiProfile,
  getAiProfiles,
  getAiProfile,
  getAiProfileByApiKey,
  updateAiProfile,
  regenerateAiProfileKey,
  deleteAiProfile,
  searchAllMessages,
  createScheduledMessage,
  getPendingScheduledMessages,
  updateScheduledMessageStatus,
  getScheduledMessages,
  cancelScheduledMessage,
  removeAccountFromProfiles,
  getGroupPermission,
  setGroupPermission,
  getGroupPermissions,
  isGroupReadable,
  isGroupInteractable,
  ensureGroupPermission,
  getGroupsWithPermissions,
};
