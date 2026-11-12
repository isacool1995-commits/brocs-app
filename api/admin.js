// Кабинет администратора: создание сотрудников, смена паролей, закрытие доступа.
// Работает на сервере Vercel с секретным ключом Supabase, который в браузер не уходит.
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const FOREVER = '876000h';

async function sb(path, opt = {}) {
  const r = await fetch(URL_ + path, {
    ...opt,
    headers: { apikey: SRV, Authorization: 'Bearer ' + SRV, 'Content-Type': 'application/json', ...(opt.headers || {}) }
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { ok: r.ok, status: r.status, body };
}

async function caller(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(URL_ + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
}

async function getMember(id) {
  const r = await sb('/rest/v1/docs?col=eq.members&id=eq.' + encodeURIComponent(id) + '&select=data');
  return Array.isArray(r.body) && r.body[0] ? r.body[0].data : null;
}

function putMember(id, data) {
  return sb('/rest/v1/docs?on_conflict=col,id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ col: 'members', id, data })
  });
}

const isAdmin = m => !!m && !m.blocked && (m.access === 'r_admin' || (!m.access && m.role === 'Руководитель'));

function authError(r) {
  const m = (r.body && (r.body.msg || r.body.message || r.body.error_description || r.body.error)) || '';
  if (/already been registered|already exists/i.test(m)) return 'Сотрудник с такой почтой уже есть.';
  if (/password/i.test(m)) return 'Пароль не подходит: нужно не меньше 6 символов.';
  if (/email/i.test(m)) return 'Проверьте почту: похоже, в ней ошибка.';
  return 'Supabase не принял запрос. Повторите или проверьте данные.';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Нужен POST-запрос.' });
  if (!URL_ || !ANON || !SRV) return res.status(500).json({ error: 'Сервер не настроен: добавьте ключи Supabase в настройках Vercel.' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const now = new Date().toISOString();

  if (b.action === 'myip') {
    const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
    return res.json({ ip });
  }

  // ---- Действия без входа: первый запуск и восстановление пароля руководителя ----
  if (b.action === 'setup-status' || b.action === 'setup' || b.action === 'forgot') {
    const all = await sb('/rest/v1/docs?col=eq.members&select=id,data');
    if (!all.ok) return res.status(500).json({ error: 'База не отвечает. Повторите позже.' });
    const admins = (all.body || []).filter(x => isAdmin(x.data));

    if (b.action === 'setup-status') return res.json({ needsAdmin: admins.length === 0 });

    if (b.action === 'setup') {
      if (admins.length) return res.status(403).json({ error: 'Руководитель уже создан. Войдите со своей почтой и паролем.' });
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const name = String(b.name || '').trim().slice(0, 80) || 'Руководитель';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Проверьте почту: похоже, в ней ошибка.' });
      if (password.length < 8) return res.status(400).json({ error: 'Пароль руководителя должен быть не короче 8 символов.' });
      const r = await sb('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } }) });
      if (!r.ok) return res.status(400).json({ error: authError(r) });
      const w = await putMember(r.body.id, { name, email, access: 'r_admin', role: 'Руководитель', createdAt: now });
      return w.ok ? res.json({ ok: true }) : res.status(500).json({ error: 'Аккаунт создан, но сохранить руководителя не удалось. Повторите вход.' });
    }

    // forgot: письмо уходит только руководителю; сотрудникам пароль задаёт руководитель
    const email = String(b.email || '').trim().toLowerCase();
    const target = admins.find(x => String(x.data.email || '').toLowerCase() === email);
    if (target) {
      const origin = String(req.headers.origin || ('https://' + req.headers.host));
      await fetch(URL_ + '/auth/v1/recover?redirect_to=' + encodeURIComponent(origin + '/'), {
        method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
    }
    return res.json({ ok: true });
  }

  const user = await caller(req);
  if (!user) return res.status(401).json({ error: 'Сессия истекла. Войдите заново.' });

  // Первый вход владельца: если администратора ещё нет, вошедший становится администратором.
  if (b.action === 'claim') {
    const r = await sb('/rest/v1/docs?col=eq.members&select=data');
    if (!r.ok) return res.status(500).json({ error: 'База не отвечает. Повторите позже.' });
    if ((r.body || []).some(x => isAdmin(x.data))) return res.status(403).json({ error: 'Администратор уже назначен.' });
    const name = String(b.name || (user.user_metadata && user.user_metadata.name) || 'Руководитель').slice(0, 80);
    const w = await putMember(user.id, { name, email: user.email, access: 'r_admin', role: 'Руководитель', createdAt: now });
    return w.ok ? res.json({ ok: true }) : res.status(500).json({ error: 'Не удалось сохранить администратора.' });
  }

  const me = await getMember(user.id);
  if (!isAdmin(me)) return res.status(403).json({ error: 'Это может делать только администратор.' });

  if (b.action === 'create') {
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Введите имя сотрудника.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Проверьте почту: похоже, в ней ошибка.' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов.' });
    const r = await sb('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } })
    });
    if (!r.ok) return res.status(400).json({ error: authError(r) });
    const access = String(b.access || 'r_manager');
    const data = { name, email, dept: String(b.dept || ''), access, role: access === 'r_admin' ? 'Руководитель' : 'Менеджер', createdAt: now };
    const w = await putMember(r.body.id, data);
    if (!w.ok) return res.status(500).json({ error: 'Аккаунт создан, но карточку сотрудника сохранить не удалось. Обновите страницу.' });
    return res.json({ ok: true, id: r.body.id, data });
  }

  if (b.action === 'password') {
    const id = String(b.id || ''), password = String(b.password || '');
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов.' });
    const r = await sb('/auth/v1/admin/users/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ password }) });
    return r.ok ? res.json({ ok: true }) : res.status(400).json({ error: authError(r) });
  }

  if (b.action === 'block') {
    const id = String(b.id || '');
    if (id === user.id) return res.status(400).json({ error: 'Себе закрыть доступ нельзя.' });
    const m = await getMember(id);
    if (!m) return res.status(404).json({ error: 'Сотрудник не найден.' });
    const r = await sb('/auth/v1/admin/users/' + encodeURIComponent(id), {
      method: 'PUT', body: JSON.stringify({ ban_duration: b.blocked ? FOREVER : 'none' })
    });
    if (!r.ok) return res.status(400).json({ error: authError(r) });
    const data = Object.assign({}, m, { blocked: !!b.blocked });
    const w = await putMember(id, data);
    return w.ok ? res.json({ ok: true, data }) : res.status(500).json({ error: 'Доступ изменён, но карточку обновить не удалось.' });
  }

  return res.status(400).json({ error: 'Неизвестное действие.' });
};
