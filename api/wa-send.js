// Отправка сообщения клиенту из карточки сделки через Profit Bot.
const { URL_, ANON, caller, body, configured } = require('./_sb');
const { CHANNELS, provider, ourNumbers, isOur, normPhone, digits, getDoc, putDoc } = require('./_chat');
const brox = require('./_brox');

const KEY = process.env.PROFITBOT_API_KEY || '';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Нужен POST-запрос.' });
  if (!configured()) return res.status(500).json({ error: 'Сервер не настроен: нет ключей Supabase.' });
  const via = await provider();
  if (via === 'profitbot' && !KEY) return res.status(500).json({ error: 'Мессенджеры не подключены: добавьте PROFITBOT_API_KEY в настройках Vercel.' });
  if (via === 'brox' && !brox.configured()) return res.status(500).json({ error: 'Brox Connect не подключён: добавьте BROX_API_URL и BROX_API_KEY в настройках Vercel.' });
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
  const numbers = await ourNumbers();
  const known = normPhone(contact['instance_' + channel]);

  if (via === 'brox') {
    if (channel !== 'whatsapp') return res.status(400).json({ error: 'Через Brox Connect работает только WhatsApp.' });
    let bx;
    try {
      const ch = await brox.pickChannel(numbers, known);
      // Скрытый номер (…@lid) отправляем как есть, иначе — по телефону
      const chatId = String(contact['chat_' + channel] || '');
      const bxTo = /@lid$/.test(chatId) ? chatId : (normPhone(contact.phoneNorm || contact.phone) || digits(chatId.split('@')[0]));
      if (!bxTo) return res.status(400).json({ error: 'У контакта нет телефона для WhatsApp.' });
      const sent = await brox.send(ch.id, bxTo, text);
      bx = { from: normPhone(ch.phone), msgId: sent.messageId, to: bxTo };
      await putDoc('config', 'messaging_send', { ok: true, code: '', from: bx.from, at: new Date().toISOString(), provider: 'brox' }).catch(() => {});
    } catch (e) {
      if (e.code === 'instance_not_authorized' || e.code === 'instance_not_found') {
        await putDoc('config', 'messaging_send', { ok: false, code: e.code, from: known || numbers[0] || '', at: new Date().toISOString(), provider: 'brox' }).catch(() => {});
      }
      return res.status(e instanceof brox.BroxError ? 400 : 500).json({ error: e instanceof brox.BroxError ? e.message : 'Сообщение не отправлено.' });
    }
    const doc = { deal: rows[0].id, contact: deal.contact, owner: deal.owner || '', channel, dir: 'out', text, type: 'text',
      from: bx.from, chatId: bx.to, source: 'crm', by: user.id, msgId: bx.msgId, status: 'queued', at: new Date().toISOString() };
    const id = 'c_out_' + String(bx.msgId).replace(/[^A-Za-z0-9_.~:@+-]/g, '');
    await putDoc('chat', id, doc);
    return res.json({ ok: true, id, data: doc });
  }

  const from = (known && isOur(numbers, known) ? known : '') || numbers[0] || '';
  if (!from) return res.status(400).json({ error: 'Не задан номер для отправки: укажите его в «Настройки → Мессенджеры».' });

  let pr, pj = {};
  try {
    pr = await fetch('https://api.profitbot.tech/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, messenger: channel, to, text })
    });
    pj = await pr.json().catch(() => ({}));
  } catch (e) { return res.status(502).json({ error: 'Profit Bot не отвечает. Повторите позже.' }); }
  const now = new Date().toISOString();
  const code = (pj.error && pj.error.code) || '';
  // Итог последней отправки виден в значке связи: так CRM узнаёт, что номер отключился в Profit Bot.
  if (pr.ok || code === 'instance_not_authorized' || code === 'instance_not_found') {
    await putDoc('config', 'messaging_send', { ok: pr.ok, code, from, at: now }).catch(() => {});
  }
  if (!pr.ok) {
    const hint = {
      instance_not_authorized: 'Номер +' + from + ' отключён в Profit Bot. Откройте кабинет Profit Bot → «Управление каналами» → WA/' + from.slice(-4) + ', нажмите «Подключить» и отсканируйте QR-код телефоном с этим номером.',
      instance_not_found: 'Номер +' + from + ' не подключён к аккаунту Profit Bot. Проверьте номер в «Настройки → Мессенджеры».',
      unauthorized: 'Profit Bot не принял API-ключ. Проверьте PROFITBOT_API_KEY в настройках Vercel.'
    }[code];
    return res.status(400).json({ error: hint || (pj.error && pj.error.message) || 'Profit Bot не принял сообщение.' });
  }

  const doc = { deal: rows[0].id, contact: deal.contact, owner: deal.owner || '', channel, dir: 'out', text, type: 'text',
    from, chatId: to, source: 'crm', by: user.id, msgId: pj.id || '', status: pj.status || 'queued', at: now };
  const id = 'c_out_' + String(pj.id || Date.now().toString(36)).replace(/[^A-Za-z0-9_.~:@+-]/g, '');
  await putDoc('chat', id, doc);
  return res.json({ ok: true, id, data: doc });
};
