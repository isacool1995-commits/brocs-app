// Почта: подключение ящиков (IMAP/SMTP), получение и отправка писем.
// Пароли ящиков хранятся в базе только в зашифрованном виде и в браузер не уходят.
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { SRV, sb, caller, getDoc, putDoc, isAdmin, body, configured } = require('./_sb');

const KEY = crypto.createHash('sha256').update('broks-mail:' + SRV).digest();
const FIRST_SYNC_DAYS = 14;
const FIRST_SYNC_MAX = 30;
const SYNC_MAX = 40;
const TEXT_MAX = 40000;

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function imapClient(acc, pass) {
  return new ImapFlow({
    host: acc.imap_host, port: acc.imap_port, secure: acc.imap_port === 993,
    auth: { user: acc.login, pass }, logger: false, socketTimeout: 20000
  });
}
function smtpTransport(acc, pass) {
  return nodemailer.createTransport({
    host: acc.smtp_host, port: acc.smtp_port, secure: acc.smtp_port === 465,
    auth: { user: acc.login, pass }, connectionTimeout: 15000
  });
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}
const addr = list => (list && list.value ? list.value : []).map(a => ({ name: a.name || '', email: (a.address || '').toLowerCase() }));

async function loadAccounts(withPass) {
  const r = await sb('/rest/v1/mail_accounts?select=*&order=created_at');
  const rows = Array.isArray(r.body) ? r.body : [];
  return rows.map(a => withPass ? a : { id: a.id, email: a.email, name: a.name, imap_host: a.imap_host, smtp_host: a.smtp_host });
}

async function access(req) {
  const user = await caller(req);
  if (!user) return { error: [401, 'Сессия истекла. Войдите заново.'] };
  const me = await getDoc('members', user.id);
  if (!me || me.blocked) return { error: [403, 'Нет доступа.'] };
  if (isAdmin(me)) return { user, me, admin: true };
  const role = await getDoc('roles', me.access || 'r_manager');
  if (!role || !role.mail) return { error: [403, 'У вашего профиля нет доступа к почте. Обратитесь к руководителю.'] };
  return { user, me, admin: false };
}

function friendly(e) {
  const m = String((e && (e.responseText || e.response || e.message)) || '');
  if (/auth|login|credential|password|invalid/i.test(m)) return 'Почта не приняла логин или пароль. Для Gmail, Mail.ru и Яндекса нужен специальный «пароль для приложений».';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'Сервер почты не найден. Проверьте адреса IMAP и SMTP.';
  if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(m)) return 'Сервер почты не отвечает. Проверьте порты и повторите.';
  return 'Почта ответила ошибкой. Проверьте настройки и повторите.';
}

async function syncAccount(acc) {
  const pass = decrypt(acc.pass_enc);
  const client = imapClient(acc, pass);
  let added = 0;
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const box = client.mailbox;
    let last = Number(acc.last_uid) || 0;
    if (acc.uidvalidity && String(acc.uidvalidity) !== String(box.uidValidity)) last = 0;
    let uids = last
      ? await client.search({ uid: (last + 1) + ':*' }, { uid: true })
      : await client.search({ since: new Date(Date.now() - FIRST_SYNC_DAYS * 864e5) }, { uid: true });
    uids = (uids || []).filter(u => u > last).sort((a, b) => a - b);
    uids = last ? uids.slice(0, SYNC_MAX) : uids.slice(-FIRST_SYNC_MAX);
    let maxUid = last;
    if (uids.length) {
      for await (const msg of client.fetch(uids.join(','), { uid: true, source: true, internalDate: true }, { uid: true })) {
        const p = await simpleParser(msg.source);
        const text = (p.text || stripHtml(p.html) || '').slice(0, TEXT_MAX);
        const data = {
          box: acc.id, boxEmail: acc.email, folder: 'in',
          from: addr(p.from)[0] || { name: '', email: '' }, to: addr(p.to), cc: addr(p.cc),
          subject: String(p.subject || '').slice(0, 300), text,
          date: (p.date || msg.internalDate || new Date()).toISOString(),
          messageId: p.messageId || '', inReplyTo: p.inReplyTo || '',
          attachments: (p.attachments || []).map(a => a.filename || 'вложение').slice(0, 20),
          seen: false
        };
        await putDoc('mail', 'm_' + acc.id.slice(0, 8) + '_' + msg.uid, data);
        added++;
        if (msg.uid > maxUid) maxUid = msg.uid;
      }
    }
    await sb('/rest/v1/mail_accounts?id=eq.' + acc.id, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_uid: maxUid, uidvalidity: Number(box.uidValidity) || null })
    });
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return added;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Нужен POST-запрос.' });
  if (!configured()) return res.status(500).json({ error: 'Сервер не настроен: нет ключей Supabase.' });
  const a = await access(req);
  if (a.error) return res.status(a.error[0]).json({ error: a.error[1] });
  const b = body(req);

  if (b.action === 'boxes') return res.json({ boxes: await loadAccounts(false) });

  if (b.action === 'add-box') {
    if (!a.admin) return res.status(403).json({ error: 'Подключать ящики может только администратор.' });
    const acc = {
      email: String(b.email || '').trim().toLowerCase(), name: String(b.name || '').trim().slice(0, 80),
      imap_host: String(b.imap_host || '').trim(), imap_port: Number(b.imap_port) || 993,
      smtp_host: String(b.smtp_host || '').trim(), smtp_port: Number(b.smtp_port) || 465,
      login: String(b.login || b.email || '').trim()
    };
    const pass = String(b.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(acc.email)) return res.status(400).json({ error: 'Проверьте адрес почты.' });
    if (!acc.imap_host || !acc.smtp_host) return res.status(400).json({ error: 'Укажите серверы IMAP и SMTP.' });
    if (!pass) return res.status(400).json({ error: 'Введите пароль для приложений.' });
    try {
      const c = imapClient(acc, pass); await c.connect(); await c.logout();
      await smtpTransport(acc, pass).verify();
    } catch (e) { return res.status(400).json({ error: friendly(e) }); }
    const w = await sb('/rest/v1/mail_accounts?on_conflict=email', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(Object.assign({}, acc, { pass_enc: encrypt(pass), last_uid: 0, uidvalidity: null }))
    });
    if (!w.ok) return res.status(500).json({ error: 'Не удалось сохранить ящик.' });
    return res.json({ ok: true, boxes: await loadAccounts(false) });
  }

  if (b.action === 'del-box') {
    if (!a.admin) return res.status(403).json({ error: 'Отключать ящики может только администратор.' });
    await sb('/rest/v1/mail_accounts?id=eq.' + encodeURIComponent(String(b.id || '')), { method: 'DELETE' });
    return res.json({ ok: true, boxes: await loadAccounts(false) });
  }

  if (b.action === 'sync') {
    const accs = await loadAccounts(true);
    let added = 0; const errors = [];
    for (const acc of accs) {
      try { added += await syncAccount(acc); } catch (e) { errors.push(acc.email + ': ' + friendly(e)); }
    }
    return res.json({ ok: true, added, errors });
  }

  if (b.action === 'send') {
    const accs = await loadAccounts(true);
    const acc = accs.find(x => x.id === b.box) || accs[0];
    if (!acc) return res.status(400).json({ error: 'Сначала подключите почтовый ящик.' });
    const to = String(b.to || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!to.length || to.some(x => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return res.status(400).json({ error: 'Проверьте адрес получателя.' });
    const subject = String(b.subject || '').slice(0, 300) || '(без темы)';
    const text = String(b.text || '').slice(0, TEXT_MAX);
    if (!text.trim()) return res.status(400).json({ error: 'Напишите текст письма.' });
    try {
      const info = await smtpTransport(acc, decrypt(acc.pass_enc)).sendMail({
        from: acc.name ? { name: acc.name, address: acc.email } : acc.email,
        to: to.join(', '), subject, text,
        inReplyTo: b.inReplyTo || undefined, references: b.inReplyTo || undefined
      });
      const data = {
        box: acc.id, boxEmail: acc.email, folder: 'out',
        from: { name: acc.name || '', email: acc.email }, to: to.map(e => ({ name: '', email: e })), cc: [],
        subject, text, date: new Date().toISOString(), messageId: info.messageId || '', inReplyTo: b.inReplyTo || '',
        attachments: [], seen: true, by: a.user.id, deal: String(b.deal || '')
      };
      const id = 'o_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      await putDoc('mail', id, data);
      return res.json({ ok: true, id, data });
    } catch (e) { return res.status(400).json({ error: friendly(e) }); }
  }

  return res.status(400).json({ error: 'Неизвестное действие.' });
};
