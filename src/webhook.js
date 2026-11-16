import crypto from 'node:crypto';
import { getAccount } from './accounts.js';
import { logger } from './logger.js';

// Отдельная очередь на каждую компанию: медленная CRM одной компании не тормозит остальные
const queues = new Map();
const listeners = new Set();

/** Подписка на события внутри процесса (лента событий в личном кабинете). */
export const onEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));

export const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

/** Отправляет событие в CRM компании, которой принадлежит канал. */
export function emit(accountId, event, channelId, data) {
  const payload = { event, channelId, timestamp: Date.now(), data };
  for (const fn of listeners) fn(accountId, payload);

  let q = queues.get(accountId);
  if (!q) queues.set(accountId, (q = { items: [], running: false }));
  q.items.push(payload);
  if (q.items.length > 1000) q.items.shift(); // защита памяти, если CRM долго недоступна
  if (!q.running) drain(accountId, q);
}

async function drain(accountId, q) {
  q.running = true;
  while (q.items.length) await deliver(accountId, q.items.shift());
  q.running = false;
}

/** Одна попытка доставки — используется и для кнопки «Проверить webhook». */
export async function deliverOnce(account, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(account.webhook_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sign(account.webhook_secret, body), 'user-agent': 'BroxConnect/1.0' },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: 'manual',
  });
  return res.status;
}

async function deliver(accountId, payload) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const account = getAccount(accountId); // адрес могли поменять, пока событие ждало
    if (!account?.webhook_url) return;
    try {
      const status = await deliverOnce(account, payload);
      if (status >= 200 && status < 300) return;
      logger.warn({ accountId, status, attempt, event: payload.event }, 'webhook: CRM ответила ошибкой');
    } catch (err) {
      logger.warn({ accountId, err: err.message, attempt, event: payload.event }, 'webhook: не удалось доставить');
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  logger.error({ accountId, event: payload.event }, 'webhook: событие не доставлено после 5 попыток');
}
