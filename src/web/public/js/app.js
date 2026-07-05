// ---- State ----
let currentPage = 'dashboard';
let currentChat = null; // { account_id, chat_id, name }
let allChats = [];
let activityLog = [];

// ---- Socket.IO ----
const socket = io();

socket.on('connect', () => {
  document.getElementById('connection-indicator').textContent = 'Conectado ao painel';
});

socket.on('disconnect', () => {
  document.getElementById('connection-indicator').textContent = 'Desconectado...';
});

socket.on('connect_error', (err) => {
  document.getElementById('connection-indicator').textContent = 'Erro de conexão';
  if (err && (err.message === 'Unauthorized' || /unauth/i.test(err.message))) {
    window.location.href = '/login.html';
  } else {
    toast(`Socket: ${err?.message || 'erro desconhecido'}`, 'error');
  }
});

socket.on('wa:event', (event) => {
  const { type, data, timestamp } = event;

  if (type === 'qr') {
    document.getElementById('qr-display').style.display = 'block';
    document.getElementById('qr-image').src = data.qr;
    document.getElementById('qr-account-name').textContent = `Conta: ${data.accountName} (${data.accountId})`;
    // Auto-switch to accounts page if not there
    if (currentPage !== 'accounts') navigateTo('accounts');
    toast(`QR Code gerado para ${data.accountName}`, 'info');
  }

  if (type === 'connection') {
    if (data.status === 'connected') {
      document.getElementById('qr-display').style.display = 'none';
      toast(`${data.accountName || data.accountId} conectado!`, 'success');
    } else if (data.status === 'disconnected') {
      toast(`${data.accountName || data.accountId} desconectado (${data.statusCode || '?'}: ${data.reason || 'unknown'})`, 'error');
    } else if (data.status === 'reconnecting') {
      toast(`Reconectando ${data.accountName || data.accountId} (tentativa ${data.attempt || '?'})...`, 'info');
    } else if (data.status === 'failed') {
      toast(`${data.accountName || data.accountId} falhou: ${data.reason || 'unknown'}`, 'error');
    } else if (data.status === 'logged_out') {
      toast(`${data.accountName || data.accountId} deslogado — escaneie o QR novamente`, 'error');
    }
    refreshAll();
  }

  if (type === 'message') {
    // Update current chat if open
    if (currentChat && data.account_id === currentChat.account_id && data.chat_id === currentChat.chat_id) {
      appendMessage(data);
      scrollMessagesToBottom();
    }
    // Refresh chat list
    loadChats();
    if (currentPage === 'dashboard') {
      loadDashboard();
    }
  }

  if (type === 'receipt') {
    // Update message status in real-time
    const bubble = document.querySelector(`[data-msg-id="${data.messageId}"] .msg-status`);
    if (bubble) {
      const parent = bubble.parentElement;
      const oldStatus = parent.querySelector('.msg-status');
      if (oldStatus) {
        oldStatus.outerHTML = messageStatusIcon(data.status).trim();
      }
    }
  }

  // Add to activity feed
  addActivityItem(event);
});

// ---- Navigation ----
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    navigateTo(btn.dataset.page);
  });
});

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
  document.getElementById(`page-${page}`).style.display = '';

  if (page === 'dashboard') loadDashboard();
  if (page === 'accounts') loadAccounts();
  if (page === 'messages') { loadAccountFilter(); loadChats(); }
  if (page === 'search') { loadSearchAccountFilter(); }
  if (page === 'contacts') { loadContactsAccountFilter(); searchContacts(); }
  if (page === 'scheduled') loadScheduled();
  if (page === 'groups') { loadGroupsAccountFilter(); loadGroups(); }
  if (page === 'activity') renderActivityFeed();
  if (page === 'ai-profiles') loadProfiles();
}

// ---- API helpers ----
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    return new Promise(() => {}); // never resolves; halts caller
  }
  return res.json();
}

// ---- Dashboard ----
async function loadDashboard() {
  const [stats, accounts, chats] = await Promise.all([
    api('/stats'),
    api('/accounts'),
    api('/chats?limit=8'),
  ]);

  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card">
      <div class="label">Contas conectadas</div>
      <div class="value green">${stats.accounts_connected}/${stats.accounts_total}</div>
    </div>
    <div class="stat-card">
      <div class="label">Total de mensagens</div>
      <div class="value">${stats.total_messages.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="label">Mensagens hoje</div>
      <div class="value blue">${stats.today_messages.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="label">Conversas</div>
      <div class="value">${stats.total_chats.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="label">Contatos</div>
      <div class="value">${stats.total_contacts.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="label">Perfis de IA</div>
      <div class="value orange">${stats.ai_profiles_total || 0}</div>
    </div>
  `;

  document.getElementById('dash-accounts').innerHTML = accounts.length === 0
    ? '<div class="empty-state"><h3>Nenhuma conta configurada</h3><p>Vá para Contas para adicionar sua primeira conta WhatsApp</p></div>'
    : accounts.map(a => accountCardHTML(a)).join('');

  document.getElementById('dash-chats').innerHTML = chats.length === 0
    ? '<div class="empty-state" style="padding:30px"><p>Nenhuma conversa ainda. As mensagens aparecerão aqui conforme chegarem.</p></div>'
    : chats.map(c => chatItemHTML(c)).join('');
}

// ---- Accounts ----
async function loadAccounts() {
  const accounts = await api('/accounts');
  document.getElementById('accounts-list').innerHTML = accounts.length === 0
    ? '<div class="empty-state"><h3>Nenhuma conta</h3><p>Clique em "+ Nova Conta" para começar</p></div>'
    : accounts.map(a => accountCardHTML(a)).join('');
}

function accountCardHTML(a) {
  const status = a.live_connected ? 'connected' : 'disconnected';
  const statusLabel = a.live_connected ? 'Conectado' : 'Desconectado';
  const typeLabel = a.type === 'business' ? 'Business' : 'Pessoal';
  return `
    <div class="account-card">
      <div class="account-top">
        <div class="account-info">
          <h3>${esc(a.name)}</h3>
          <div class="meta">${typeLabel} &bull; ${a.phone || 'Sem telefone'} &bull; ID: ${esc(a.id)}</div>
        </div>
        <span class="status-badge ${status}">${statusLabel}</span>
      </div>
      <div class="account-actions">
        ${!a.live_connected ? `<button class="btn sm" onclick="connectAcc('${esc(a.id)}')">Conectar</button>` : ''}
        ${a.live_connected ? `<button class="btn sm" onclick="disconnectAcc('${esc(a.id)}')">Desconectar</button>` : ''}
        ${a.live_connected ? `<button class="btn sm" onclick="resolveContacts('${esc(a.id)}')">Resolver Contatos</button>` : ''}
        <button class="btn sm danger" onclick="deleteAcc('${esc(a.id)}', '${esc(a.name)}')">Remover</button>
      </div>
    </div>
  `;
}

function showAddAccountModal() {
  document.getElementById('new-acc-id').value = '';
  document.getElementById('new-acc-name').value = '';
  document.getElementById('add-account-modal').style.display = 'flex';
}

async function addAccount() {
  const id = document.getElementById('new-acc-id').value.trim();
  const name = document.getElementById('new-acc-name').value.trim();
  const type = document.getElementById('new-acc-type').value;
  if (!id || !name) return toast('Preencha ID e Nome', 'error');

  document.getElementById('add-account-modal').style.display = 'none';
  toast('Criando conta e gerando QR code...', 'info');
  const res = await api('/accounts', { method: 'POST', body: { id, name, type } });
  if (res.error) return toast(res.error, 'error');
  loadAccounts();
}

async function connectAcc(id) {
  toast('Conectando...', 'info');
  await api(`/accounts/${id}/connect`, { method: 'POST' });
}

async function disconnectAcc(id) {
  if (!confirm('Desconectar esta conta?')) return;
  await api(`/accounts/${id}/disconnect`, { method: 'POST' });
  toast('Desconectado', 'info');
  refreshAll();
}

async function resolveContacts(id) {
  toast('Resolvendo contatos dos grupos... isso pode levar alguns minutos', 'info');
  try {
    const result = await api(`/accounts/${id}/resolve-contacts`, { method: 'POST' });
    toast(`Pronto! ${result.resolved} contatos resolvidos de ${result.groups} grupos (${result.errors} erros)`, 'success');
  } catch (err) {
    toast('Erro ao resolver contatos: ' + err.message, 'error');
  }
}

async function deleteAcc(id, name) {
  if (!confirm(`Remover a conta "${name}"? Isso apaga todas as mensagens e dados de autenticação.`)) return;
  await api(`/accounts/${id}`, { method: 'DELETE' });
  toast('Conta removida', 'info');
  refreshAll();
}

// ---- Messages ----
async function loadAccountFilter() {
  const accounts = await api('/accounts');
  const sel = document.getElementById('chat-account-filter');
  sel.innerHTML = '<option value="">Todas as contas</option>' +
    accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
}

async function loadChats() {
  const accountId = document.getElementById('chat-account-filter')?.value || '';
  const params = accountId ? `?account_id=${accountId}&limit=100` : '?limit=100';
  allChats = await api(`/chats${params}`);
  renderChatList(allChats);
}

function filterChats() {
  const q = document.getElementById('chat-search').value.toLowerCase();
  const filtered = allChats.filter(c =>
    (c.chat_name || '').toLowerCase().includes(q) ||
    (c.last_message || '').toLowerCase().includes(q) ||
    (c.chat_id || '').includes(q)
  );
  renderChatList(filtered);
}

function renderChatList(chats) {
  document.getElementById('chat-list').innerHTML = chats.length === 0
    ? '<div class="empty-state" style="padding:40px"><p>Nenhuma conversa encontrada</p></div>'
    : chats.map(c => chatItemHTML(c)).join('');
}

function chatItemHTML(c) {
  const initial = (c.chat_name || '?')[0].toUpperCase();
  const isGroup = c.is_group ? ' group' : '';
  const time = c.last_message_time ? formatTime(c.last_message_time) : '';
  const chatTypeBadge = c.is_group
    ? `<span class="chat-type-badge group">Grupo${c.group_name ? ' - ' + esc(c.group_name) : ''}</span>`
    : '<span class="chat-type-badge individual">Individual</span>';
  const accountLabel = c.account_name || c.account_id;
  const accountClass = c.account_type === 'business' ? 'business' : 'personal';
  const accountBadge = `<span class="chat-type-badge ${accountClass}">${esc(accountLabel)}</span>`;
  return `
    <div class="chat-item" onclick="openChat('${esc(c.account_id)}', '${esc(c.chat_id)}', '${esc(c.chat_name || c.chat_id)}', ${c.is_group ? 1 : 0}, '${esc(c.group_name || '')}', '${esc(c.account_type || '')}', '${esc(accountLabel)}')">
      <div class="chat-avatar${isGroup}">${initial}</div>
      <div class="chat-details">
        <div class="name">${esc(c.chat_name || c.chat_id)} ${chatTypeBadge} ${accountBadge}</div>
        <div class="last-msg">${esc((c.last_message || '').substring(0, 60))}</div>
      </div>
      <div class="chat-meta">
        <div class="time">${time}</div>
        ${c.message_count > 1 ? `<div class="count">${c.message_count}</div>` : ''}
      </div>
    </div>
  `;
}

async function openChat(accountId, chatId, name, isGroup, groupName, accountType, accountLabel) {
  currentChat = { account_id: accountId, chat_id: chatId, name };
  const avatarClass = isGroup ? ' group' : '';
  const chatTypeBadge = isGroup
    ? `<span class="chat-type-badge group" style="margin-left:8px">Grupo${groupName ? ' - ' + esc(groupName) : ''}</span>`
    : '<span class="chat-type-badge individual" style="margin-left:8px">Individual</span>';
  const accClass = accountType === 'business' ? 'business' : 'personal';
  const accountBadge = `<span class="chat-type-badge ${accClass}" style="margin-left:4px">${esc(accountLabel || accountId)}</span>`;
  document.getElementById('msg-header').innerHTML = `
    <div class="chat-avatar${avatarClass}" style="width:32px;height:32px;font-size:14px">${(name||'?')[0].toUpperCase()}</div>
    <div>
      <div>${esc(name)} ${chatTypeBadge} ${accountBadge}</div>
      <div style="font-size:11px;color:var(--text-dim);font-weight:400">${esc(chatId)}</div>
    </div>
  `;
  document.getElementById('msg-input-area').style.display = 'flex';

  const messages = await api(`/messages?account_id=${accountId}&chat_id=${encodeURIComponent(chatId)}&limit=100`);
  const body = document.getElementById('msg-body');
  body.innerHTML = '';
  // Messages come newest first, reverse for display
  messages.reverse().forEach(m => appendMessage(m));
  scrollMessagesToBottom();
}

function messageStatusIcon(status) {
  if (status === 'read') return '<span class="msg-status read" title="Lido">&#10003;&#10003;</span>';
  if (status === 'delivered') return '<span class="msg-status delivered" title="Entregue">&#10003;&#10003;</span>';
  if (status === 'sent') return '<span class="msg-status sent" title="Enviado">&#10003;</span>';
  return '';
}

function appendMessage(m) {
  const body = document.getElementById('msg-body');
  const div = document.createElement('div');
  div.className = `message-bubble ${m.is_from_me ? 'sent' : 'received'}`;
  if (m.id) div.dataset.msgId = m.id;

  let html = '';
  if (!m.is_from_me && m.is_group && m.sender_name) {
    html += `<div class="msg-sender">${esc(m.sender_name)}</div>`;
  }
  if (m.media_type) {
    html += `<div class="msg-media">${esc(m.media_type)}</div>`;
  }
  html += `<div>${esc(m.content || '')}</div>`;
  const statusHtml = m.is_from_me ? messageStatusIcon(m.status || 'sent') : '';
  html += `<div class="msg-time">${formatTime(m.timestamp)} ${statusHtml}</div>`;

  div.innerHTML = html;
  body.appendChild(div);
}

function scrollMessagesToBottom() {
  const body = document.getElementById('msg-body');
  body.scrollTop = body.scrollHeight;
}

async function sendMsg() {
  if (!currentChat) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  try {
    await api('/send', { method: 'POST', body: {
      account_id: currentChat.account_id,
      chat_id: currentChat.chat_id,
      text,
    }});
  } catch (err) {
    toast('Erro ao enviar: ' + err.message, 'error');
  }
}

// ---- Activity ----
function addActivityItem(event) {
  activityLog.unshift(event);
  if (activityLog.length > 200) activityLog.pop();
  if (currentPage === 'activity') renderActivityFeed();
}

function renderActivityFeed() {
  const feed = document.getElementById('activity-feed');
  if (activityLog.length === 0) {
    feed.innerHTML = '<div class="empty-state" style="padding:40px"><h3>Nenhuma atividade ainda</h3><p>Eventos aparecerão aqui em tempo real conforme mensagens chegarem e conexões mudarem</p></div>';
    return;
  }

  feed.innerHTML = activityLog.map(e => {
    const { type, data, timestamp } = e;
    const time = formatTime(Math.floor(timestamp / 1000));

    if (type === 'message') {
      const icon = data.is_from_me ? 'msg-out' : 'msg-in';
      const arrow = data.is_from_me ? 'Enviado' : 'Recebido';
      const chatName = data.group_name || data.chat_id?.split('@')[0] || '';
      return `
        <div class="feed-item">
          <div class="feed-icon ${icon}">${data.is_from_me ? '↑' : '↓'}</div>
          <div class="feed-content">
            <div class="feed-title">${arrow} &bull; ${esc(chatName)} &bull; ${esc(data.account_id)}</div>
            <div class="feed-text">${esc((data.content || '').substring(0, 100))}</div>
          </div>
          <div class="feed-time">${time}</div>
        </div>
      `;
    }

    if (type === 'connection') {
      return `
        <div class="feed-item">
          <div class="feed-icon event">⚡</div>
          <div class="feed-content">
            <div class="feed-title">${esc(data.accountName || data.accountId)}</div>
            <div class="feed-text">Status: ${esc(data.status)}${data.phone ? ' (' + data.phone + ')' : ''}</div>
          </div>
          <div class="feed-time">${time}</div>
        </div>
      `;
    }

    if (type === 'qr') {
      return `
        <div class="feed-item">
          <div class="feed-icon event">📱</div>
          <div class="feed-content">
            <div class="feed-title">QR Code gerado</div>
            <div class="feed-text">${esc(data.accountName)} - aguardando scan</div>
          </div>
          <div class="feed-time">${time}</div>
        </div>
      `;
    }

    return '';
  }).join('');
}

// ---- Helpers ----
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.textContent = message;
  container.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

function refreshAll() {
  if (currentPage === 'dashboard') loadDashboard();
  if (currentPage === 'accounts') loadAccounts();
  if (currentPage === 'messages') loadChats();
  if (currentPage === 'contacts') searchContacts();
  if (currentPage === 'scheduled') loadScheduled();
  if (currentPage === 'groups') loadGroups();
  if (currentPage === 'ai-profiles') loadProfiles();
  // 'search' and 'activity' are user-driven; don't auto-refresh
}

// Polling fallback: refresh active page every 10s when tab is visible.
// This complements the Socket.IO push so the UI keeps current even if the
// WebSocket disconnects silently.
setInterval(() => {
  if (document.visibilityState === 'visible') refreshAll();
}, 10000);

// Refresh immediately when tab regains focus after being hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAll();
});

// ---- Contacts ----
let allContacts = [];
const CONTACTS_PAGE_SIZE = 15;
let contactsPage = 0;
let contactsTotal = [];

async function loadContactsAccountFilter() {
  const accounts = await api('/accounts');
  const sel = document.getElementById('contacts-account-filter');
  sel.innerHTML = '<option value="">Todas as contas</option>' +
    accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
}

async function searchContacts() {
  const search = document.getElementById('contacts-search')?.value || '';
  const accountId = document.getElementById('contacts-account-filter')?.value || '';
  const typeFilter = document.getElementById('contacts-type-filter')?.value || '';

  let params = '?limit=5000';
  if (search) params += `&search=${encodeURIComponent(search)}`;
  if (accountId) params += `&account_id=${accountId}`;
  if (typeFilter !== '') params += `&is_group=${typeFilter}`;

  contactsTotal = await api(`/contacts${params}`);
  contactsPage = 0;
  renderContactsPage();
}

function renderContactsPage() {
  const start = contactsPage * CONTACTS_PAGE_SIZE;
  const pageData = contactsTotal.slice(start, start + CONTACTS_PAGE_SIZE);
  allContacts = contactsTotal; // keep for editContact lookup
  renderContacts(pageData, contactsTotal.length, start);
}

function contactsPagePrev() {
  if (contactsPage > 0) { contactsPage--; renderContactsPage(); }
}

function contactsPageNext() {
  if ((contactsPage + 1) * CONTACTS_PAGE_SIZE < contactsTotal.length) { contactsPage++; renderContactsPage(); }
}

function renderContacts(contacts, total, offset) {
  const tbody = document.getElementById('contacts-tbody');
  const empty = document.getElementById('contacts-empty');
  const table = document.getElementById('contacts-table');
  const count = document.getElementById('contacts-count');
  const pag = document.getElementById('contacts-pagination');

  total = total || contacts.length;
  offset = offset || 0;

  count.textContent = `${total} contato${total !== 1 ? 's' : ''}`;

  if (total === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    if (pag) pag.style.display = 'none';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  tbody.innerHTML = contacts.map(c => {
    const typeClass = c.is_group ? 'group' : 'person';
    const typeLabel = c.is_group ? 'Grupo' : 'Pessoa';
    const displayName = c.name || c.push_name || c.phone || c.id;
    const updated = c.updated_at ? formatDateTime(c.updated_at) : '-';
    return `
      <tr>
        <td class="contact-name">${esc(displayName)}</td>
        <td>${esc(c.phone || '-')}</td>
        <td><span class="contact-type ${typeClass}">${typeLabel}</span></td>
        <td>${esc(c.account_id)}</td>
        <td>${updated}</td>
        <td><button class="btn sm" onclick="editContact('${esc(c.id)}', '${esc(c.account_id)}')">Editar</button></td>
      </tr>
    `;
  }).join('');

  // Pagination controls
  if (pag) {
    const totalPages = Math.ceil(total / CONTACTS_PAGE_SIZE);
    if (totalPages <= 1) {
      pag.style.display = 'none';
    } else {
      pag.style.display = '';
      pag.innerHTML = `
        <button class="btn sm" onclick="contactsPagePrev()" ${contactsPage === 0 ? 'disabled' : ''}>Anterior</button>
        <span class="pagination-info">Pagina ${contactsPage + 1} de ${totalPages}</span>
        <button class="btn sm" onclick="contactsPageNext()" ${contactsPage >= totalPages - 1 ? 'disabled' : ''}>Proxima</button>
      `;
    }
  }
}

function editContact(id, accountId) {
  const contact = allContacts.find(c => c.id === id && c.account_id === accountId);
  if (!contact) return;

  document.getElementById('contact-edit-id').value = id;
  document.getElementById('contact-edit-account').value = accountId;
  document.getElementById('contact-edit-name').value = contact.name || contact.push_name || '';
  document.getElementById('contact-edit-phone').value = contact.phone || '';
  document.getElementById('contact-modal').style.display = 'flex';
}

async function saveContact() {
  const id = document.getElementById('contact-edit-id').value;
  const accountId = document.getElementById('contact-edit-account').value;
  const name = document.getElementById('contact-edit-name').value.trim();

  if (!name) return toast('Preencha o nome', 'error');

  const res = await api(`/contacts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { account_id: accountId, name },
  });

  if (res.error) return toast(res.error, 'error');

  document.getElementById('contact-modal').style.display = 'none';
  toast('Contato atualizado', 'success');
  searchContacts();
}

async function deleteContact() {
  const id = document.getElementById('contact-edit-id').value;
  const accountId = document.getElementById('contact-edit-account').value;

  if (!confirm('Remover este contato?')) return;

  const res = await api(`/contacts/${encodeURIComponent(id)}?account_id=${accountId}`, {
    method: 'DELETE',
  });

  if (res.error) return toast(res.error, 'error');

  document.getElementById('contact-modal').style.display = 'none';
  toast('Contato removido', 'info');
  searchContacts();
}

function exportContacts() {
  const csv = ['Nome,Telefone,Tipo,Conta,Atualizado'];
  for (const c of allContacts) {
    const name = (c.name || c.push_name || '').replace(/"/g, '""');
    const type = c.is_group ? 'Grupo' : 'Pessoa';
    csv.push(`"${name}","${c.phone || ''}","${type}","${c.account_id}","${c.updated_at || ''}"`);
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'contatos-whatsapp.csv';
  a.click();
}

function formatDateTime(dt) {
  if (!dt) return '-';
  const d = new Date(dt + (dt.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ---- AI Profiles ----
async function loadProfiles() {
  const profiles = await api('/ai-profiles');
  const container = document.getElementById('profiles-list');
  if (profiles.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Nenhum perfil de IA</h3><p>Crie um perfil para controlar o acesso de cada IA às suas contas WhatsApp</p></div>';
    return;
  }
  container.innerHTML = profiles.map(p => profileCardHTML(p)).join('');
}

function profileCardHTML(p) {
  const accountNames = p.allowed_accounts.length > 0
    ? p.allowed_accounts.join(', ')
    : '<span style="color:var(--danger)">Nenhuma conta</span>';
  const maskedKey = p.api_key.substring(0, 12) + '****' + p.api_key.substring(p.api_key.length - 4);
  const mcpCmd = `node src/mcp-entry.js --key ${p.api_key}`;
  const createdAt = new Date(p.created_at + 'Z').toLocaleDateString('pt-BR');

  return `
    <div class="profile-card">
      <div class="profile-top">
        <div class="profile-info">
          <h3>${esc(p.name)}</h3>
          <div class="meta">Criado em ${createdAt}</div>
        </div>
        <div class="profile-actions-top">
          <button class="btn sm" onclick="showProfileModal('${esc(p.id)}')">Editar</button>
          <button class="btn sm danger" onclick="deleteProfile('${esc(p.id)}', '${esc(p.name)}')">Remover</button>
        </div>
      </div>
      <div class="profile-section">
        <div class="profile-label">Contas permitidas</div>
        <div class="profile-value">${accountNames}</div>
      </div>
      <div class="profile-section">
        <div class="profile-label">API Key</div>
        <div class="api-key-display">
          <code>${esc(maskedKey)}</code>
          <button class="btn sm" onclick="copyText('${esc(p.api_key)}', 'API Key copiada!')">Copiar</button>
        </div>
      </div>
      <div class="profile-section">
        <div class="profile-label">Comando MCP</div>
        <div class="api-key-display">
          <code class="mcp-cmd">${esc(mcpCmd)}</code>
          <button class="btn sm" onclick="copyText('${esc(mcpCmd)}', 'Comando copiado!')">Copiar</button>
        </div>
      </div>
      <div class="profile-section">
        <div class="profile-label">Configuracao JSON (Claude Desktop / Cursor)</div>
        <div class="api-key-display">
          <code class="mcp-cmd">--key ${esc(p.api_key)}</code>
          <button class="btn sm" onclick="copyMcpJson('${esc(p.api_key)}')">Copiar JSON</button>
        </div>
      </div>
      <div class="profile-footer">
        <button class="btn sm" onclick="regenerateKey('${esc(p.id)}', '${esc(p.name)}')">Regenerar Chave</button>
      </div>
    </div>
  `;
}

async function showProfileModal(editId) {
  const accounts = await api('/accounts');
  const checkboxes = document.getElementById('profile-accounts-checkboxes');
  let selectedAccounts = [];

  if (editId) {
    const profile = await api(`/ai-profiles/${editId}`);
    document.getElementById('profile-modal-title').textContent = 'Editar Perfil de IA';
    document.getElementById('profile-edit-id').value = editId;
    document.getElementById('profile-name').value = profile.name;
    selectedAccounts = profile.allowed_accounts;
  } else {
    document.getElementById('profile-modal-title').textContent = 'Novo Perfil de IA';
    document.getElementById('profile-edit-id').value = '';
    document.getElementById('profile-name').value = '';
  }

  if (accounts.length === 0) {
    checkboxes.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Nenhuma conta WhatsApp cadastrada. Adicione contas primeiro.</div>';
  } else {
    checkboxes.innerHTML = accounts.map(a => {
      const checked = selectedAccounts.includes(a.id) ? 'checked' : '';
      const typeLabel = a.type === 'business' ? 'Business' : 'Pessoal';
      return `
        <label class="account-checkbox-item">
          <input type="checkbox" value="${esc(a.id)}" ${checked}>
          <span>${esc(a.name)} <span style="color:var(--text-dim)">(${typeLabel} - ${esc(a.id)})</span></span>
        </label>
      `;
    }).join('');
  }

  document.getElementById('profile-modal').style.display = 'flex';
}

async function saveProfile() {
  const editId = document.getElementById('profile-edit-id').value;
  const name = document.getElementById('profile-name').value.trim();
  if (!name) return toast('Preencha o nome do perfil', 'error');

  const checkboxes = document.querySelectorAll('#profile-accounts-checkboxes input[type="checkbox"]:checked');
  const allowed_accounts = Array.from(checkboxes).map(cb => cb.value);

  document.getElementById('profile-modal').style.display = 'none';

  if (editId) {
    const res = await api(`/ai-profiles/${editId}`, { method: 'PUT', body: { name, allowed_accounts } });
    if (res.error) return toast(res.error, 'error');
    toast('Perfil atualizado', 'success');
  } else {
    const res = await api('/ai-profiles', { method: 'POST', body: { name, allowed_accounts } });
    if (res.error) return toast(res.error, 'error');
    toast('Perfil criado! Copie a API Key para usar no MCP.', 'success');
  }
  loadProfiles();
}

async function deleteProfile(id, name) {
  if (!confirm(`Remover o perfil "${name}"? IAs usando esta chave perderao acesso.`)) return;
  await api(`/ai-profiles/${id}`, { method: 'DELETE' });
  toast('Perfil removido', 'info');
  loadProfiles();
}

async function regenerateKey(id, name) {
  if (!confirm(`Regenerar a chave do perfil "${name}"? A chave atual sera invalidada.`)) return;
  const res = await api(`/ai-profiles/${id}/regenerate-key`, { method: 'POST' });
  if (res.error) return toast(res.error, 'error');
  toast('Nova chave gerada! Copie-a do card.', 'success');
  loadProfiles();
}

function copyText(text, message) {
  navigator.clipboard.writeText(text).then(() => {
    toast(message || 'Copiado!', 'success');
  }).catch(() => {
    toast('Erro ao copiar', 'error');
  });
}

function copyMcpJson(apiKey) {
  const json = JSON.stringify({
    mcpServers: {
      whatsapp: {
        command: 'node',
        args: ['src/mcp-entry.js', '--key', apiKey]
      }
    }
  }, null, 2);
  copyText(json, 'JSON copiado!');
}

// ---- Scheduled Messages ----
async function loadScheduled() {
  const status = document.getElementById('scheduled-status-filter')?.value || '';
  const params = status ? `?status=${status}` : '';
  const messages = await api(`/scheduled${params}`);
  const container = document.getElementById('scheduled-list');
  const empty = document.getElementById('scheduled-empty');
  const count = document.getElementById('scheduled-count');

  count.textContent = `${messages.length} mensagen${messages.length !== 1 ? 's' : ''}`;

  if (messages.length === 0) {
    container.innerHTML = '';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';

  container.innerHTML = messages.map(m => {
    const scheduledDate = new Date(m.scheduled_at * 1000).toLocaleString('pt-BR');
    const statusClass = m.status === 'sent' ? 'success' : m.status === 'failed' ? 'error' : m.status === 'cancelled' ? 'dim' : 'pending';
    const statusLabel = { pending: 'Pendente', sent: 'Enviado', failed: 'Falha', cancelled: 'Cancelado' }[m.status] || m.status;
    const sentInfo = m.sent_at ? ` | Enviado: ${new Date(m.sent_at * 1000).toLocaleString('pt-BR')}` : '';
    const errorInfo = m.error ? `<div style="color:var(--danger);font-size:11px;margin-top:2px">${esc(m.error)}</div>` : '';
    const cancelBtn = m.status === 'pending' ? `<button class="btn sm danger" onclick="cancelScheduled('${m.id}')" style="margin-left:auto">Cancelar</button>` : '';

    return `
      <div class="feed-item">
        <div class="feed-icon event"><span class="scheduled-status-dot ${statusClass}"></span></div>
        <div class="feed-content" style="flex:1">
          <div class="feed-title">${esc(m.contact_name || m.chat_id.split('@')[0])} <span class="scheduled-badge ${statusClass}">${statusLabel}</span></div>
          <div class="feed-text">${esc((m.text || '').substring(0, 150))}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px">Agendado: ${scheduledDate} | Conta: ${esc(m.account_id)}${sentInfo}</div>
          ${errorInfo}
        </div>
        ${cancelBtn}
      </div>
    `;
  }).join('');
}

async function cancelScheduled(id) {
  if (!confirm('Cancelar esta mensagem agendada?')) return;
  await api(`/scheduled/${id}`, { method: 'DELETE' });
  toast('Mensagem cancelada', 'info');
  loadScheduled();
}

// ---- Global Search ----
let searchOffset = 0;
let searchQuery = '';
let searchDebounce = null;

async function loadSearchAccountFilter() {
  const accounts = await api('/accounts');
  const sel = document.getElementById('search-account-filter');
  sel.innerHTML = '<option value="">Todas as contas</option>' +
    accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
}

async function performGlobalSearch() {
  const q = document.getElementById('global-search-input').value.trim();
  if (!q) return;
  searchQuery = q;
  searchOffset = 0;
  const accountId = document.getElementById('search-account-filter')?.value || '';
  const params = `?q=${encodeURIComponent(q)}&limit=50${accountId ? '&account_id=' + accountId : ''}`;
  const results = await api(`/search${params}`);
  renderSearchResults(results, true);
}

async function loadMoreSearch() {
  const accountId = document.getElementById('search-account-filter')?.value || '';
  const params = `?q=${encodeURIComponent(searchQuery)}&limit=50&offset=${searchOffset}${accountId ? '&account_id=' + accountId : ''}`;
  const results = await api(`/search${params}`);
  renderSearchResults(results, false);
}

function renderSearchResults(results, reset) {
  const container = document.getElementById('search-results');
  const empty = document.getElementById('search-empty');
  const countEl = document.getElementById('search-count');
  const loadMore = document.getElementById('search-load-more');

  if (reset) container.innerHTML = '';

  if (results.length === 0 && reset) {
    empty.style.display = '';
    countEl.textContent = '';
    loadMore.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  searchOffset += results.length;

  if (reset) {
    countEl.textContent = results.length >= 50 ? '50+ resultados' : `${results.length} resultado${results.length !== 1 ? 's' : ''}`;
  }

  loadMore.style.display = results.length >= 50 ? '' : 'none';

  const html = results.map(r => {
    const time = formatTime(r.timestamp);
    const chatName = r.chat_name || r.chat_id;
    const arrow = r.is_from_me ? 'Enviado' : 'Recebido';
    const iconClass = r.is_from_me ? 'msg-out' : 'msg-in';
    const accountBadge = r.account_type === 'business'
      ? '<span class="chat-type-badge business">business</span>'
      : '<span class="chat-type-badge personal">pessoal</span>';
    const typeBadge = r.is_group
      ? '<span class="chat-type-badge group">Grupo</span>'
      : '';
    const content = highlightTerm(esc((r.content || '').substring(0, 200)), searchQuery);

    return `
      <div class="feed-item search-result" onclick="goToChat('${esc(r.account_id)}', '${esc(r.chat_id)}', '${esc(chatName)}')" style="cursor:pointer">
        <div class="feed-icon ${iconClass}">${r.is_from_me ? '↑' : '↓'}</div>
        <div class="feed-content">
          <div class="feed-title">${esc(chatName)} ${typeBadge} ${accountBadge}</div>
          <div class="feed-text">${content}</div>
          ${r.sender_name && r.is_group && !r.is_from_me ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px">${esc(r.sender_name)}</div>` : ''}
        </div>
        <div class="feed-time">${time}</div>
      </div>
    `;
  }).join('');

  container.innerHTML += html;
}

function highlightTerm(text, term) {
  if (!term) return text;
  const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(regex, '<mark>$1</mark>');
}

function goToChat(accountId, chatId, name) {
  navigateTo('messages');
  openChat(accountId, chatId, name, chatId.endsWith('@g.us') ? 1 : 0, '', '', '');
}

// ---- Group Permissions ----
let allGroups = [];
const GROUPS_PAGE_SIZE = 15;
let groupsPage = 0;
let groupsFiltered = [];

async function loadGroupsAccountFilter() {
  const accounts = await api('/accounts');
  const sel = document.getElementById('groups-account-filter');
  sel.innerHTML = '<option value="">Todas as contas</option>' +
    accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
}

async function loadGroups() {
  const accountId = document.getElementById('groups-account-filter')?.value || '';
  const params = accountId ? `?account_id=${accountId}` : '';
  allGroups = await api(`/groups${params}`);
  groupsPage = 0;
  filterGroups();
}

function filterGroups() {
  const q = (document.getElementById('groups-search')?.value || '').toLowerCase();
  groupsFiltered = q
    ? allGroups.filter(g => (g.group_name || '').toLowerCase().includes(q) || (g.group_id || '').includes(q))
    : allGroups;
  groupsPage = 0;
  renderGroupsPage();
}

function groupsPagePrev() {
  if (groupsPage > 0) { groupsPage--; renderGroupsPage(); }
}

function groupsPageNext() {
  if ((groupsPage + 1) * GROUPS_PAGE_SIZE < groupsFiltered.length) { groupsPage++; renderGroupsPage(); }
}

function renderGroupsPage() {
  const start = groupsPage * GROUPS_PAGE_SIZE;
  const pageData = groupsFiltered.slice(start, start + GROUPS_PAGE_SIZE);
  renderGroups(pageData, groupsFiltered.length);
}

function renderGroups(groups, total) {
  const tbody = document.getElementById('groups-tbody');
  const empty = document.getElementById('groups-empty');
  const table = document.getElementById('groups-table');
  const count = document.getElementById('groups-count');
  const pag = document.getElementById('groups-pagination');

  total = total || groups.length;
  count.textContent = `${total} grupo${total !== 1 ? 's' : ''}`;

  if (total === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    if (pag) pag.style.display = 'none';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  tbody.innerHTML = groups.map(g => {
    const readChecked = g.can_read ? 'checked' : '';
    const interactChecked = g.can_interact ? 'checked' : '';
    return `
      <tr>
        <td class="contact-name">${esc(g.group_name || g.group_id)}</td>
        <td>${esc(g.account_id)}</td>
        <td>
          <label class="toggle">
            <input type="checkbox" ${readChecked}
              onchange="toggleGroupPerm('${esc(g.group_id)}', '${esc(g.account_id)}', 'can_read', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td>
          <label class="toggle">
            <input type="checkbox" ${interactChecked}
              onchange="toggleGroupPerm('${esc(g.group_id)}', '${esc(g.account_id)}', 'can_interact', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>
    `;
  }).join('');

  // Pagination
  if (pag) {
    const totalPages = Math.ceil(total / GROUPS_PAGE_SIZE);
    if (totalPages <= 1) {
      pag.style.display = 'none';
    } else {
      pag.style.display = '';
      pag.innerHTML = `
        <button class="btn sm" onclick="groupsPagePrev()" ${groupsPage === 0 ? 'disabled' : ''}>Anterior</button>
        <span class="pagination-info">Pagina ${groupsPage + 1} de ${totalPages}</span>
        <button class="btn sm" onclick="groupsPageNext()" ${groupsPage >= totalPages - 1 ? 'disabled' : ''}>Proxima</button>
      `;
    }
  }
}

async function toggleGroupPerm(groupId, accountId, field, value) {
  // Find current state
  const group = allGroups.find(g => g.group_id === groupId && g.account_id === accountId);
  if (!group) return;

  const body = {
    group_id: groupId,
    account_id: accountId,
    can_read: field === 'can_read' ? value : group.can_read,
    can_interact: field === 'can_interact' ? value : group.can_interact,
  };

  await api('/group-permissions', { method: 'PUT', body });

  // Update local state
  group[field] = value ? 1 : 0;
  toast(`Permissao atualizada`, 'success');
}

// ---- Init ----
loadDashboard();
