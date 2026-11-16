const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { starting: 'запуск', qr: 'ждёт QR', connected: 'подключён', reconnecting: 'переподключение', logged_out: 'отвязан', stopped: 'остановлен' };
const TYPE_LABEL = { image: '📷 Фото', video: '🎬 Видео', audio: '🎤 Аудио', document: '📄 Документ', sticker: 'Стикер', location: '📍 Геолокация', contact: '👤 Контакт' };

const state = { account: null, channels: [], channelId: null, chat: null, events: null };

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-brox': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url.startsWith('/api/')) showAuth();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const api = (method, url, body) => call(method, '/api/v1' + url, body);

// ---------- вход ----------
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('[data-auth]').forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  $('companyField').hidden = mode !== 'register';
  $('authSubmit').textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти';
  $('authForm').password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('authError').textContent = '';
}
document.querySelectorAll('[data-auth]').forEach((b) => (b.onclick = () => setAuthMode(b.dataset.auth)));

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await call('POST', '/auth/' + authMode, Object.fromEntries(f));
    if (r.apiKey) sessionStorageSafe('newKey', r.apiKey);
    await boot();
  } catch (err) { $('authError').textContent = err.message; }
};

function sessionStorageSafe(k, v) { try { v === undefined ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }
function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }

function showAuth() {
  $('appView').hidden = true;
  $('authView').hidden = false;
  state.events?.close();
}

$('logout').onclick = async () => { await call('POST', '/auth/logout'); showAuth(); };

// ---------- вкладки ----------
function openTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
  try { localStorage.setItem('broxTab', name); } catch {}
  if (name === 'chats') loadChats();
}
document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));

// ---------- номера ----------
async function loadChannels() {
  state.channels = await api('GET', '/channels');
  $('channels').innerHTML = state.channels.length ? state.channels.map((c) => `
    <div class="ch">
      <div class="row between"><strong>${esc(c.name)}</strong><span class="badge ${c.status}">${STATUS[c.status] || c.status}</span></div>
      <div class="muted">${c.phone ? '+' + esc(c.phone) : 'номер ещё не привязан'} · <code>${esc(c.id)}</code></div>
      ${c.qr ? `<img src="${c.qr}" alt="QR-код для привязки"><div class="muted">Телефон: WhatsApp → Настройки → Связанные устройства → Привязка устройства</div>` : ''}
      ${c.status === 'starting' || c.status === 'reconnecting' ? '<div class="muted">Соединяемся с WhatsApp…</div>' : ''}
      <div class="row">
        ${c.status === 'logged_out' || c.status === 'stopped' ? `<button data-relink="${esc(c.id)}">Новый QR</button>` : ''}
        <button class="ghost" data-rename="${esc(c.id)}">Переименовать</button>
        <button class="danger" data-del="${esc(c.id)}">Удалить</button>
      </div>
    </div>`).join('') : '<p class="muted">Пока нет номеров. Нажмите «Подключить номер».</p>';

  const sel = $('chatChannel');
  const cur = state.channelId;
  sel.innerHTML = state.channels.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.phone ? ' (+' + esc(c.phone) + ')' : ''}</option>`).join('');
  state.channelId = state.channels.some((c) => c.id === cur) ? cur : state.channels[0]?.id ?? null;
  if (state.channelId) sel.value = state.channelId;
}

$('channels').onclick = async (e) => {
  const { del, relink, rename } = e.target.dataset;
  try {
    if (del && confirm('Удалить номер? Он будет отвязан, история сообщений удалится.')) await api('DELETE', '/channels/' + del);
    if (relink) await api('POST', `/channels/${relink}/relink`);
    if (rename) {
      const name = prompt('Новое название');
      if (name) await api('PATCH', '/channels/' + rename, { name });
    }
  } catch (err) { alert(err.message); }
  loadChannels();
};

$('add').onclick = async () => {
  try { await api('POST', '/channels', { name: $('newName').value }); $('newName').value = ''; }
  catch (err) { alert(err.message); }
  loadChannels();
};

// ---------- чаты ----------
$('chatChannel').onchange = (e) => { state.channelId = e.target.value; state.chat = null; loadChats(); renderThreadHead(); $('thread').innerHTML = ''; };

async function loadChats() {
  if (!state.channelId) { $('chatList').innerHTML = '<p class="muted">Сначала подключите номер.</p>'; return; }
  const chats = await api('GET', `/channels/${state.channelId}/chats`);
  $('chatList').innerHTML = chats.length ? chats.map((c) => `
    <button class="chatItem ${c.chat === state.chat ? 'active' : ''}" data-chat="${esc(c.chat)}" data-name="${esc(c.name || '')}">
      <strong>${esc(c.name || formatChat(c.chat))}</strong>
      <span class="preview">${c.lastFromMe ? 'Вы: ' : ''}${esc(c.lastText || TYPE_LABEL[c.lastType] || '')}</span>
    </button>`).join('') : '<p class="muted">Диалогов пока нет.</p>';
}

$('chatList').onclick = (e) => {
  const b = e.target.closest('[data-chat]');
  if (b) openChat(b.dataset.chat, b.dataset.name);
};
$('openChat').onclick = () => { const to = $('newChatTo').value.replace(/\D/g, ''); if (to) openChat(to, ''); };

const fmtTime = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function formatChat(chat) { return /^\d+$/.test(chat) ? '+' + chat : chat; }

function renderThreadHead(name) {
  $('threadHead').textContent = state.chat ? `${name || formatChat(state.chat)}${name ? ' · ' + formatChat(state.chat) : ''}` : 'Выберите диалог';
  $('replyForm').hidden = !state.chat;
}

async function openChat(chat, name) {
  state.chat = chat;
  renderThreadHead(name);
  document.querySelectorAll('.chatItem').forEach((b) => b.classList.toggle('active', b.dataset.chat === chat));
  await loadThread();
  $('replyText').focus();
}

async function loadThread() {
  if (!state.chat) return;
  const msgs = await api('GET', `/channels/${state.channelId}/messages?chat=${encodeURIComponent(state.chat)}&limit=100`);
  const STATUS_MARK = { pending: 'отправляется', sent: '✓', delivered: '✓✓', read: '✓✓ прочитано', played: '✓✓ прослушано', error: 'ошибка' };
  $('thread').innerHTML = msgs.map((m) => {
    const media = m.media?.url ? `<a href="${esc(m.media.url)}" target="_blank" rel="noopener">${TYPE_LABEL[m.type] || 'Файл'}: ${esc(m.media.fileName || '')}</a>` : '';
    const body = m.text ? `<div class="body">${esc(m.text)}</div>` : (media ? '' : `<div class="body">${esc(TYPE_LABEL[m.type] || m.type)}</div>`);
    const status = m.fromMe && m.status ? ' · ' + esc(STATUS_MARK[m.status] || m.status) : '';
    return `<div class="msg ${m.fromMe ? 'me' : ''}">${media}${body}<div class="meta">${fmtTime(m.timestamp)}${status}</div></div>`;
  }).join('') || '<p class="muted">Сообщений пока нет — напишите первым.</p>';
}

$('replyForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('replyText').value.trim();
  if (!text) return;
  $('replyText').value = '';
  try { await api('POST', `/channels/${state.channelId}/messages`, { to: state.chat, text }); }
  catch (err) { alert(err.message); $('replyText').value = text; }
  loadThread(); loadChats();
};

// ---------- интеграция ----------
function renderAccount() {
  const a = state.account;
  $('company').textContent = a.company;
  $('apiKeyHint').textContent = a.apiKeyHint;
  $('webhookUrl').value = a.webhookUrl || '';
  $('webhookSecret').textContent = a.webhookSecret;
  $('apiBase').textContent = location.origin + '/api/v1';
  const k = sessionGet('newKey');
  $('newKeyBox').hidden = !k;
  $('newKey').textContent = k || '';
}

$('rotateKey').onclick = async () => {
  if (!confirm('Старый ключ перестанет работать сразу. Продолжить?')) return;
  const { apiKey } = await api('POST', '/account/api-key');
  sessionStorageSafe('newKey', apiKey);
  state.account = await api('GET', '/account');
  renderAccount();
};
$('copyKey').onclick = () => navigator.clipboard?.writeText($('newKey').textContent).then(() => { sessionStorageSafe('newKey'); $('copyKey').textContent = 'Скопировано'; });
$('saveWebhook').onclick = async () => {
  try { state.account = await api('PATCH', '/account', { webhookUrl: $('webhookUrl').value }); $('webhookRes').textContent = 'Сохранено'; }
  catch (err) { $('webhookRes').textContent = err.message; }
};
$('testWebhook').onclick = async () => {
  $('webhookRes').textContent = 'Отправляем тестовое событие…';
  try {
    const r = await api('POST', '/account/webhook-test');
    $('webhookRes').textContent = r.ok ? `CRM ответила ${r.status} — всё работает` : `Не получилось: ${r.error || 'ответ ' + r.status}`;
  } catch (err) { $('webhookRes').textContent = err.message; }
};
$('rotateSecret').onclick = async () => {
  if (!confirm('После смены обновите секрет в CRM. Продолжить?')) return;
  state.account = await api('POST', '/account/webhook-secret');
  renderAccount();
};

// ---------- события ----------
function connectEvents() {
  state.events?.close();
  state.events = new EventSource('/api/v1/events');
  state.events.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const row = document.createElement('div');
    row.textContent = `${new Date(e.timestamp).toLocaleTimeString('ru-RU')}  ${e.event}  [${e.channelId}]  ${JSON.stringify(e.data)}`;
    $('log').prepend(row);
    while ($('log').childElementCount > 300) $('log').lastChild.remove();
    if (e.event === 'channel.status') loadChannels();
    if (e.event.startsWith('message.') && e.channelId === state.channelId && !$('tab-chats').hidden) {
      loadChats();
      if (e.data.chat === state.chat) loadThread();
    }
  };
}

// ---------- старт ----------
async function boot() {
  const cfg = await call('GET', '/auth/config').catch(() => ({}));
  if (cfg.appName) { document.title = cfg.appName; document.querySelectorAll('.appName').forEach((n) => (n.textContent = cfg.appName)); }
  $('signupTab').hidden = cfg.allowSignup === false;
  try {
    state.account = await call('GET', '/api/v1/account');
  } catch {
    showAuth();
    return;
  }
  $('authView').hidden = true;
  $('appView').hidden = false;
  renderAccount();
  await loadChannels();
  connectEvents();
  let tab = 'channels';
  try { tab = localStorage.getItem('broxTab') || tab; } catch {}
  openTab(tab);
}

setInterval(() => { if (!$('appView').hidden && !$('tab-channels').hidden) loadChannels().catch(() => {}); }, 5000);
boot();
