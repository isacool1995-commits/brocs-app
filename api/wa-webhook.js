// Вебхук Profit Bot: входящие и исходящие сообщения WhatsApp, Telegram, MAX и статусы доставки.
// Каждый запрос проверяется по подписи X-Signature (HMAC-SHA256 с секретом из кабинета Profit Bot).
const crypto = require('crypto');
const { configured } = require('./_sb');
const { CHANNELS, ourNumber, normPhone, findContact, openDealFor, firstStage, newId, sb, getDoc, putDoc } = require('./_chat');

const SECRET = process.env.PROFITBOT_WEBHOOK_SECRET || '';

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

function validSignature(raw, header) {
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(header || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function onStatus(ev) {
  const r = await sb('/rest/v1/docs?col=eq.chat&select=id,data&limit=1&data->>msgId=eq.' + encodeURIComponent(ev.id));
  const row = Array.isArray(r.body) && r.body[0];
  if (!row) return;
  const data = Object.assign({}, row.data, { status: ev.status });
  if (ev.error) data.error = ev.error.message || ev.error.code;
  await putDoc('chat', row.id, data);
}

async function onMessage(ev) {
  const dir = ev.event === 'message.incoming' ? 'in' : 'out';
  if (dir === 'out' && ev.manager && ev.manager.source === 'api') return; // уже записано при отправке из CRM
  if (ev.is_group) return;
  const id = 'c_' + String(ev.event_id).replace(/[^A-Za-z0-9_.~:@+-]/g, '');
  if (await getDoc('chat', id)) return; // повторная доставка

  const channel = CHANNELS[ev.channel] ? ev.channel : 'whatsapp';
  const contactIn = ev.contact || {};
  const phone = normPhone(contactIn.phone);
  const chatId = String(contactIn.chat_id || '');
  const instancePhone = (ev.instance && ev.instance.phone) || '';
  const now = new Date((Number(ev.timestamp) || Date.now() / 1000) * 1000).toISOString();

  let contact = await findContact(channel, phone, chatId);
  if (!contact) {
    const name = contactIn.name || ev.sender_name || (phone ? '+' + phone : 'Клиент ' + CHANNELS[channel]);
    contact = { id: newId(), data: { name, phone: phone ? '+' + phone : '', phoneNorm: phone, email: '', company: '', owner: '', createdAt: now } };
  }
  const cdata = Object.assign({}, contact.data);
  if (chatId) cdata['chat_' + channel] = chatId;
  if (instancePhone) cdata['instance_' + channel] = instancePhone;
  if (phone && !cdata.phoneNorm) cdata.phoneNorm = phone;
  await putDoc('contacts', contact.id, cdata);

  let deal = await openDealFor(contact.id);
  if (!deal) {
    deal = { id: newId(), data: {
      title: CHANNELS[channel] + ': ' + cdata.name, budget: 0, pipeline: 'main', stage: await firstStage(),
      owner: '', contact: contact.id, company: cdata.company || '', tags: [CHANNELS[channel]], f: {},
      createdAt: now, updatedAt: now,
      notes: [{ sys: true, by: '', at: now, text: 'Сделка создана из ' + (dir === 'in' ? 'входящего' : 'исходящего') + ' сообщения ' + CHANNELS[channel] }]
    } };
  }
  const ddata = Object.assign({}, deal.data, { updatedAt: now, lastMsgAt: now });
  if (dir === 'in') ddata.unread = (Number(ddata.unread) || 0) + 1;
  await putDoc('deals', deal.id, ddata);

  const m = ev.message || {};
  await putDoc('chat', id, {
    deal: deal.id, contact: contact.id, owner: ddata.owner || '', channel, dir,
    text: String(m.text || m.caption || '').slice(0, 8000), type: m.type || 'text',
    media_url: m.media_url || '', file_name: m.file_name || '', duration: m.duration || null,
    from: instancePhone, chatId, name: contactIn.name || ev.sender_name || '',
    source: ev.manager ? ev.manager.source : '', at: now
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'Брокс: вебхук Profit Bot' });
  if (!configured() || !SECRET) return res.status(500).json({ error: 'Вебхук не настроен: нет PROFITBOT_WEBHOOK_SECRET или ключей Supabase.' });
  const raw = await readRaw(req);
  if (!validSignature(raw, req.headers['x-signature'])) return res.status(401).json({ error: 'Неверная подпись.' });
  let ev;
  try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Неверный JSON.' }); }
  if (ev.instance && !ourNumber(ev.instance.phone)) return res.status(200).json({ ok: true, skipped: 'чужой номер' });
  try {
    if (ev.event === 'message.status') await onStatus(ev);
    else if (ev.event === 'message.incoming' || ev.event === 'message.outgoing') await onMessage(ev);
  } catch (e) {
    console.error('wa-webhook', e);
    return res.status(500).json({ error: 'Не удалось сохранить событие.' });
  }
  return res.status(200).json({ ok: true });
};
