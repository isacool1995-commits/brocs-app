// Вебхук Profit Bot: входящие и исходящие сообщения WhatsApp, Telegram, MAX и статусы доставки.
// Каждый запрос проверяется по подписи X-Signature (HMAC-SHA256 с секретом из кабинета Profit Bot).
const crypto = require('crypto');
const { configured } = require('./_sb');
const { ourNumbers, isOur, putDoc } = require('./_chat');
const { onStatus, onMessage } = require('./_inbox');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'Брокс: вебхук Profit Bot' });
  if (!configured() || !SECRET) return res.status(500).json({ error: 'Вебхук не настроен: нет PROFITBOT_WEBHOOK_SECRET или ключей Supabase.' });
  const raw = await readRaw(req);
  if (!validSignature(raw, req.headers['x-signature'])) return res.status(401).json({ error: 'Неверная подпись.' });
  let ev;
  try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Неверный JSON.' }); }
  if (ev.event === 'test') {
    await putDoc('config', 'messaging_last', { event: 'test', at: new Date().toISOString() }).catch(() => {});
    return res.status(200).json({ ok: true });
  }
  const numbers = await ourNumbers();
  await putDoc('config', 'messaging_last', { event: ev.event, at: new Date().toISOString(), instance: ev.instance ? ev.instance.phone : '', ours: !ev.instance || isOur(numbers, ev.instance.phone) }).catch(() => {});
  if (ev.instance && !isOur(numbers, ev.instance.phone)) return res.status(200).json({ ok: true, skipped: 'чужой номер' });
  try {
    if (ev.event === 'message.status') await onStatus(ev);
    else if (ev.event === 'message.incoming' || ev.event === 'message.outgoing') await onMessage(ev);
  } catch (e) {
    console.error('wa-webhook', e);
    return res.status(500).json({ error: 'Не удалось сохранить событие.' });
  }
  return res.status(200).json({ ok: true });
};
