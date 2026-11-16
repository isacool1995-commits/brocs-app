// Brox Connect: наш сервис подключения WhatsApp по QR-коду.
// Адрес и ключ задаются в Vercel: BROX_API_URL (например, https://connect.example.com), BROX_API_KEY, BROX_WEBHOOK_SECRET.
const { normPhone } = require('./_chat');

const BASE = (process.env.BROX_API_URL || '').replace(/\/$/, '');
const KEY = process.env.BROX_API_KEY || '';
const SECRET = process.env.BROX_WEBHOOK_SECRET || '';

class BroxError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function call(method, path, body) {
  if (!BASE || !KEY) throw new BroxError('Brox Connect не настроен: добавьте BROX_API_URL и BROX_API_KEY в настройках Vercel.', 'not_configured');
  let r;
  try {
    r = await fetch(BASE + '/api/v1' + path, {
      method,
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    throw new BroxError('Brox Connect не отвечает. Повторите позже.', 'unreachable');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new BroxError('Brox Connect не принял API-ключ. Проверьте BROX_API_KEY в настройках Vercel.', 'unauthorized');
  if (!r.ok) throw new BroxError(j.error || 'Brox Connect вернул ошибку ' + r.status, 'http_' + r.status);
  return j;
}

/** Номер Brox Connect для отправки: тот, что уже переписывался с клиентом, иначе первый наш подключённый. */
async function pickChannel(numbers, preferPhone) {
  const list = await call('GET', '/channels');
  const ours = list.filter(c => c.phone && (!numbers.length || numbers.includes(normPhone(c.phone))));
  const ch = ours.find(c => normPhone(c.phone) === normPhone(preferPhone)) || ours.find(c => c.status === 'connected') || ours[0];
  if (!ch) throw new BroxError('В Brox Connect нет подключённого номера' + (numbers.length ? ' +' + numbers.join(', +') : '') + '. Подключите его по QR-коду в кабинете Brox Connect.', 'instance_not_found');
  if (ch.status !== 'connected') throw new BroxError('Номер +' + ch.phone + ' отключён в Brox Connect. Откройте кабинет Brox Connect → «Номера» и отсканируйте QR-код телефоном с этим номером.', 'instance_not_authorized');
  return ch;
}

async function send(channelId, to, text) {
  return call('POST', '/channels/' + encodeURIComponent(channelId) + '/messages', { to, text });
}

const crypto = require('crypto');
function validSignature(raw, header) {
  if (!SECRET) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(header || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Статусы Brox Connect → статусы, которые показывает карточка сделки
const STATUS = { pending: 'queued', sent: 'sent', delivered: 'delivered', read: 'read', played: 'read', error: 'failed' };
// Типы сообщений Brox Connect → типы CRM
const TYPE = { audio: 'voice' };

module.exports = { BroxError, configured: () => !!(BASE && KEY), secretSet: () => !!SECRET, pickChannel, send, validSignature, STATUS, TYPE };
