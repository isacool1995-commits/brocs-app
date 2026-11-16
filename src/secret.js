import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Секрет сервера для подписи ссылок на медиа. Создаётся один раз и хранится в data/.
const file = path.join(config.dataDir, 'server-secret');
let secret;
try {
  secret = fs.readFileSync(file, 'utf8').trim();
} catch {
  secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
}

const sig = (p) => crypto.createHmac('sha256', secret).update(p).digest('base64url').slice(0, 32);

/** Ссылка на медиафайл, которую можно открыть без API-ключа (как ссылки на файлы в мессенджерах). */
export const signMediaPath = (p) => `${p}?sig=${sig(p)}`;

export function verifyMediaSig(p, value) {
  const a = Buffer.from(sig(p)), b = Buffer.from(String(value || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
