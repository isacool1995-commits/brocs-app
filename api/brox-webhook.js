// Вебхук Brox Connect: входящие и исходящие сообщения WhatsApp, статусы доставки и состояние номеров.
// Подпись: X-Signature = HMAC-SHA256 тела запроса с секретом из кабинета Brox Connect (BROX_WEBHOOK_SECRET).
const { configured } = require('./_sb');
const { ourNumbers, isOur, normPhone, sb, putDoc } = require('./_chat');
const { onStatus, onMessage } = require('./_inbox');
const brox = require('./_brox');

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

// Событие Brox Connect → общий вид, который понимает _inbox.js
function toInbox(ev) {
  const d = ev.data || {};
  const lid = !!d.isLid || /@lid$/.test(String(d.chat || ''));
  return {
    event: ev.event,
    event_id: 'bx_' + ev.channelId + '_' + d.messageId,
    channel: 'whatsapp',
    is_group: !!d.isGroup,
    timestamp: Math.floor((Number(d.timestamp) || Date.now()) / 1000),
    sender_name: d.senderName || '',
    instance: { phone: ev.channelPhone || '' },
    contact: { phone: lid ? '' : d.chat, chat_id: String(d.chat || ''), name: d.senderName || '' },
    manager: d.fromMe ? { source: 'phone' } : null,
    message: {
      type: brox.TYPE[d.type] || d.type || 'text',
      text: d.text || (d.type === 'location' && d.location ? 'Геолокация: https://maps.google.com/?q=' + d.location.lat + ',' + d.location.lng : ''),
      media_url: d.media ? d.media.url : '',
      file_name: d.media ? d.media.fileName : ''
    }
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'Брокс: вебхук Brox Connect' });
  if (!configured() || !brox.secretSet()) return res.status(500).json({ error: 'Вебхук не настроен: нет BROX_WEBHOOK_SECRET или ключей Supabase.' });
  const raw = await readRaw(req);
  if (!brox.validSignature(raw, req.headers['x-signature'])) return res.status(401).json({ error: 'Неверная подпись.' });
  let ev;
  try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Неверный JSON.' }); }
  const at = new Date().toISOString();

  if (ev.event === 'ping') {
    await putDoc('config', 'messaging_last', { event: 'test', at, provider: 'brox' }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  const numbers = await ourNumbers();
  const ours = !ev.channelPhone || isOur(numbers, ev.channelPhone);

  if (ev.event === 'channel.status') {
    // Состояние номера: значок связи в CRM показывает, если номер отвязали и нужен новый QR
    if (ours) await putDoc('config', 'messaging_brox', { status: (ev.data || {}).status, phone: normPhone(ev.channelPhone), at }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  await putDoc('config', 'messaging_last', { event: ev.event, at, instance: ev.channelPhone || '', ours, provider: 'brox' }).catch(() => {});
  if (!ours) return res.status(200).json({ ok: true, skipped: 'чужой номер' });
  try {
    if (ev.event === 'message.status') {
      const d = ev.data || {};
      await onStatus({ id: d.messageId, status: brox.STATUS[d.status] || d.status });
    } else if (ev.event === 'message.incoming' || ev.event === 'message.outgoing') {
      // Отправленное из CRM уже записано в wa-send — второй раз не пишем
      if (ev.event === 'message.outgoing' && ev.data && ev.data.messageId) {
        const r = await sb('/rest/v1/docs?col=eq.chat&select=id&limit=1&data->>msgId=eq.' + encodeURIComponent(ev.data.messageId));
        if (Array.isArray(r.body) && r.body.length) return res.status(200).json({ ok: true, skipped: 'уже записано' });
      }
      await onMessage(toInbox(ev));
    }
  } catch (e) {
    console.error('brox-webhook', e);
    return res.status(500).json({ error: 'Не удалось сохранить событие.' });
  }
  return res.status(200).json({ ok: true });
};
