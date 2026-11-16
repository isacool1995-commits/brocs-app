import path from 'node:path';
import express from 'express';
import {
  accountByApiKey,
  accountBySession,
  createSession,
  destroySession,
  login,
  publicAccount,
  purgeExpiredSessions,
  register,
  rotateApiKey,
  rotateWebhookSecret,
  SESSION_TTL_MS,
  updateSettings,
} from './accounts.js';
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  listChats,
  listMessages,
  mediaDir,
  relinkChannel,
  renameChannel,
  restoreChannels,
  sendMessage,
} from './channels.js';
import { config } from './config.js';
import { db } from './db.js';
import { httpError } from './errors.js';
import { logger } from './logger.js';
import { deliverOnce, onEvent } from './webhook.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve('public')));

// ---------- авторизация ----------
const COOKIE = 'brox_session';

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, token, maxAgeMs) {
  const attrs = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (config.secureCookies) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/**
 * Два способа войти:
 *  - CRM: заголовок Authorization: Bearer brx_... (API-ключ компании);
 *  - личный кабинет: cookie сессии. Для изменений требуем заголовок X-Brox,
 *    который сторонний сайт не может отправить без CORS, — защита от CSRF.
 */
function auth(req, _res, next) {
  const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || req.get('x-api-key');
  if (bearer) {
    req.account = accountByApiKey(bearer.trim());
    if (!req.account) return next(httpError(401, 'Неверный API-ключ'));
    req.via = 'api';
    return next();
  }
  const token = readCookie(req);
  req.account = token ? accountBySession(token) : null;
  if (!req.account) return next(httpError(401, 'Требуется вход'));
  if (!['GET', 'HEAD'].includes(req.method) && req.get('x-brox') !== '1') return next(httpError(403, 'Нет заголовка X-Brox'));
  req.via = 'web';
  next();
}

const webOnly = (req, _res, next) => (req.via === 'web' ? next() : next(httpError(403, 'Доступно только из личного кабинета')));

// Простое ограничение попыток входа: 10 в 15 минут с одного IP
const attempts = new Map();
function loginLimiter(req, _res, next) {
  const key = req.ip;
  const t = Date.now();
  const a = attempts.get(key)?.filter((x) => t - x < 15 * 60_000) ?? [];
  if (a.length >= 10) return next(httpError(429, 'Слишком много попыток, подождите 15 минут'));
  a.push(t);
  attempts.set(key, a);
  next();
}

// ---------- личный кабинет: вход и регистрация ----------
const web = express.Router();

web.get('/config', (_req, res) => res.json({ appName: config.appName, allowSignup: config.allowSignup, publicUrl: config.publicUrl }));

web.post('/register', loginLimiter, async (req, res) => {
  if (!config.allowSignup) throw httpError(403, 'Регистрация закрыта');
  const { account, apiKey } = await register(req.body ?? {});
  setCookie(res, createSession(account.id), SESSION_TTL_MS);
  res.status(201).json({ account: publicAccount(account), apiKey });
});

web.post('/login', loginLimiter, async (req, res) => {
  const account = await login(req.body?.email, req.body?.password);
  if (!account) throw httpError(401, 'Неверный email или пароль');
  setCookie(res, createSession(account.id), SESSION_TTL_MS);
  res.json({ account: publicAccount(account) });
});

web.post('/logout', (req, res) => {
  const token = readCookie(req);
  if (token) destroySession(token);
  setCookie(res, '', 0);
  res.status(204).end();
});

app.use('/auth', web);

// ---------- API v1 (CRM и личный кабинет) ----------
const api = express.Router();
api.use(auth);

api.get('/account', (req, res) => res.json(publicAccount(req.account)));

api.patch('/account', webOnly, (req, res) => {
  res.json(publicAccount(updateSettings(req.account.id, { webhookUrl: req.body?.webhookUrl, company: req.body?.company })));
});

api.post('/account/api-key', webOnly, (req, res) => res.json({ apiKey: rotateApiKey(req.account.id) }));
api.post('/account/webhook-secret', webOnly, (req, res) => res.json(publicAccount(rotateWebhookSecret(req.account.id))));

api.post('/account/webhook-test', (req, res) => {
  if (!req.account.webhook_url) throw httpError(400, 'Сначала укажите адрес webhook');
  deliverOnce(req.account, { event: 'ping', channelId: null, timestamp: Date.now(), data: { message: 'Проверка связи' } })
    .then((status) => res.json({ ok: status >= 200 && status < 300, status }))
    .catch((err) => res.json({ ok: false, error: err.message }));
});

api.get('/channels', (req, res) => res.json(listChannels(req.account.id)));
api.post('/channels', async (req, res) => res.status(201).json(await createChannel(req.account.id, req.body?.name)));
api.get('/channels/:id', (req, res) => res.json(getChannel(req.account.id, req.params.id)));
api.patch('/channels/:id', (req, res) => res.json(renameChannel(req.account.id, req.params.id, req.body?.name)));
api.post('/channels/:id/relink', async (req, res) => res.json(await relinkChannel(req.account.id, req.params.id)));
api.delete('/channels/:id', async (req, res) => {
  await deleteChannel(req.account.id, req.params.id);
  res.status(204).end();
});

api.get('/channels/:id/chats', (req, res) => res.json(listChats(req.account.id, req.params.id, req.query)));
api.get('/channels/:id/messages', (req, res) => res.json(listMessages(req.account.id, req.params.id, req.query)));
api.post('/channels/:id/messages', async (req, res) => res.json(await sendMessage(req.account.id, req.params.id, req.body ?? {})));

// Поток событий компании (Server-Sent Events) — для личного кабинета и отладки
api.get('/events', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const me = req.account.id;
  const off = onEvent((accountId, e) => accountId === me && res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => (off(), clearInterval(ping)));
});

app.use('/api/v1', api);

// Медиафайлы: отдаём только компании-владельцу канала
const ownsChannel = db.prepare('SELECT 1 FROM channels WHERE id = ? AND account_id = ?');
app.get('/media/:channelId/:file', auth, (req, res) => {
  const { channelId, file } = req.params;
  if (!ownsChannel.get(channelId, req.account.id) || !/^[\w-]+\.\w{1,10}$/.test(file)) throw httpError(404, 'Файл не найден');
  res.sendFile(path.join(mediaDir, channelId, file), { dotfiles: 'deny' }, (err) => err && !res.headersSent && res.status(404).json({ error: 'Файл не найден' }));
});

app.use('/api', (_req, _res, next) => next(httpError(404, 'Нет такого метода API')));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) logger.error({ err }, 'ошибка API');
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка' : err.message });
});

setInterval(purgeExpiredSessions, 3600_000).unref();
await restoreChannels();
app.listen(config.port, () => logger.info(`${config.appName}: ${config.publicUrl} (порт ${config.port})`));
