import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, now } from './db.js';
import { httpError } from './errors.js';

const scrypt = promisify(crypto.scrypt);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function newApiKey() {
  const key = `brx_${randomId(24)}`;
  return { key, hash: sha256(key), hint: `${key.slice(0, 8)}…${key.slice(-4)}` };
}

export function publicAccount(a) {
  return {
    id: a.id,
    email: a.email,
    company: a.company,
    apiKeyHint: a.api_key_hint,
    webhookUrl: a.webhook_url,
    webhookSecret: a.webhook_secret,
    createdAt: a.created_at,
  };
}

export async function register({ email, password, company }) {
  email = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Неверный email');
  if (String(password || '').length < 8) throw httpError(400, 'Пароль — минимум 8 символов');
  if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) throw httpError(409, 'Такой email уже зарегистрирован');

  const api = newApiKey();
  const account = {
    id: randomId(),
    email,
    password_hash: await hashPassword(String(password)),
    company: String(company || '').trim() || email,
    api_key_hash: api.hash,
    api_key_hint: api.hint,
    webhook_url: null,
    webhook_secret: randomId(24),
    created_at: now(),
  };
  db.prepare(`INSERT INTO accounts (id, email, password_hash, company, api_key_hash, api_key_hint, webhook_url, webhook_secret, created_at)
              VALUES (:id, :email, :password_hash, :company, :api_key_hash, :api_key_hint, :webhook_url, :webhook_secret, :created_at)`).run(account);
  // Полный ключ показываем один раз — в базе хранится только его хеш
  return { account, apiKey: api.key };
}

export async function login(email, password) {
  const a = db.prepare('SELECT * FROM accounts WHERE email = ?').get(String(email || '').trim());
  if (!a || !(await verifyPassword(String(password || ''), a.password_hash))) return null;
  return a;
}

export function createSession(accountId) {
  const token = randomId(32);
  db.prepare('INSERT INTO web_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), accountId, now() + SESSION_TTL_MS);
  return token;
}

export function destroySession(token) {
  db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha256(token));
}

export function accountBySession(token) {
  return db.prepare(`SELECT a.* FROM web_sessions s JOIN accounts a ON a.id = s.account_id
                     WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now()) ?? null;
}

export function accountByApiKey(key) {
  return db.prepare('SELECT * FROM accounts WHERE api_key_hash = ?').get(sha256(key)) ?? null;
}

export function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) ?? null;
}

export function rotateApiKey(accountId) {
  const api = newApiKey();
  db.prepare('UPDATE accounts SET api_key_hash = ?, api_key_hint = ? WHERE id = ?').run(api.hash, api.hint, accountId);
  return api.key;
}

export function updateSettings(accountId, { webhookUrl, company }) {
  if (webhookUrl !== undefined) {
    const url = String(webhookUrl || '').trim() || null;
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw httpError(400, 'Адрес webhook должен начинаться с http:// или https://');
    db.prepare('UPDATE accounts SET webhook_url = ? WHERE id = ?').run(url, accountId);
  }
  if (company !== undefined && String(company).trim()) {
    db.prepare('UPDATE accounts SET company = ? WHERE id = ?').run(String(company).trim(), accountId);
  }
  return getAccount(accountId);
}

export function rotateWebhookSecret(accountId) {
  db.prepare('UPDATE accounts SET webhook_secret = ? WHERE id = ?').run(randomId(24), accountId);
  return getAccount(accountId);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now());
  db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').run(now());
}

// ---------- пароль ----------

const RESET_TTL_MS = 60 * 60 * 1000; // ссылка действует 1 час

/** Создаёт одноразовый токен сброса. Возвращает null, если email не найден. */
export function createPasswordReset(email) {
  const a = db.prepare('SELECT * FROM accounts WHERE email = ?').get(String(email || '').trim());
  if (!a) return null;
  db.prepare('DELETE FROM password_resets WHERE account_id = ?').run(a.id); // старые ссылки больше не работают
  const token = randomId(32);
  db.prepare('INSERT INTO password_resets (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), a.id, now() + RESET_TTL_MS);
  return { account: a, token };
}

export async function resetPassword(token, password) {
  if (String(password || '').length < 8) throw httpError(400, 'Пароль — минимум 8 символов');
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?').get(sha256(String(token || '')), now());
  if (!row) throw httpError(400, 'Ссылка недействительна или устарела. Запросите новую.');
  await setPassword(row.account_id, password);
  db.prepare('DELETE FROM password_resets WHERE account_id = ?').run(row.account_id);
  return getAccount(row.account_id);
}

export async function changePassword(accountId, currentPassword, newPassword) {
  const a = getAccount(accountId);
  if (!(await verifyPassword(String(currentPassword || ''), a.password_hash))) throw httpError(400, 'Текущий пароль неверный');
  if (String(newPassword || '').length < 8) throw httpError(400, 'Новый пароль — минимум 8 символов');
  await setPassword(accountId, newPassword);
}

async function setPassword(accountId, password) {
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(await hashPassword(String(password)), accountId);
  // Выходим на всех устройствах — если пароль меняли из-за утечки
  db.prepare('DELETE FROM web_sessions WHERE account_id = ?').run(accountId);
}
