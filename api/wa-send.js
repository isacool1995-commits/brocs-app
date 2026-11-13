// Отправка сообщения клиенту из карточки сделки через Profit Bot.
const { URL_, ANON, caller, body, configured } = require('./_sb');
const { CHANNELS, normPhone, digits, getDoc, putDoc } = require('./_chat');

const KEY = process.env.PROFITBOT_API_KEY || '';
const DEFAULT_FROM = digits(process.env.PROFITBOT_FROM || '');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Нужен POST-запрос.' });
  if (!configured()) return res.status(500).json({ error: 'Сервер не настроен: нет ключей Supabase.' });
  if (!KEY) return res.status(500).json({ error: 'Мессенджеры не подключены: добавьте PROFITBOT_API_KEY в настройках Vercel.' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await caller(req);
  if (!user) return res.status(401).json({ error: 'Сессия истекла. Войдите заново.' });
  const b = body(req);
  const text = String(b.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Напишите сообщение.' });
  if (text.length > 4000) return res.status(400).json({ error: 'Сообщение длиннее 4000 символов.' });
  const channel = CHANNELS[b.channel] ? b.channel : 'whatsapp';

  // Сделку читаем от имени сотрудника: если права не позволяют её видеть, писать по ней нельзя.
  const r = await fetch(URL_ + '/rest/v1/docs?col=eq.deals&select=id,data&id=eq.' + encodeURIComponent(String(b.deal || '')), {
    headers: { apikey: ANON, Authorization: 'Bearer ' + token }
  });
  const rows = r.ok ? await r.json() : [];
  if (!rows.length) return res.status(403).json({ error: 'Нет доступа к этой сделке.' });
  const deal = rows[0].data;
  const contact = deal.contact ? await getDoc('contacts', deal.contact) : null;
  if (!contact) return res.status(400).json({ error: 'У сделки нет контактного лица с телефоном.' });

  const to = contact['chat_' + channel] || normPhone(contact.phoneNorm || contact.phone);
  if (!to) return res.status(400).json({ error: 'У контакта нет телефона для ' + CHANNELS[channel] + '.' });
  const from = digits(contact['instance_' + channel]) || DEFAULT_FROM;
  if (!from) return res.status(400).json({ error: 'Неизвестно, с какого номера писать: клиент ещё не писал вам в ' + CHANNELS[channel] + ', а номер по умолчанию (PROFITBOT_FROM) не задан.' });

  let pr, pj = {};
  try {
    pr = await fetch('https://api.profitbot.tech/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, messenger: channel, to, text })
    });
    pj = await pr.json().catch(() => ({}));
  } catch (e) { return res.status(502).json({ error: 'Profit Bot не отвечает. Повторите позже.' }); }
  if (!pr.ok) return res.status(400).json({ error: (pj.error && pj.error.message) || 'Profit Bot не принял сообщение.' });

  const now = new Date().toISOString();
  const doc = { deal: rows[0].id, contact: deal.contact, owner: deal.owner || '', channel, dir: 'out', text, type: 'text',
    from, chatId: to, source: 'crm', by: user.id, msgId: pj.id || '', status: pj.status || 'queued', at: now };
  const id = 'c_out_' + String(pj.id || Date.now().toString(36)).replace(/[^A-Za-z0-9_.~:@+-]/g, '');
  await putDoc('chat', id, doc);
  return res.json({ ok: true, id, data: doc });
};
