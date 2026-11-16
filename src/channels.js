import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { randomId } from './accounts.js';
import { config } from './config.js';
import { db, now } from './db.js';
import { httpError } from './errors.js';
import { logger } from './logger.js';
import { signMediaPath } from './secret.js';
import { emit } from './webhook.js';

const sessionsDir = path.join(config.dataDir, 'sessions');
export const mediaDir = path.join(config.dataDir, 'media');

/** Живые подключения: channelId → состояние сокета. Сами каналы хранятся в БД. */
const live = new Map();

const STATUS_NAMES = { 0: 'error', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'played' };
const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
};

const q = {
  insertChannel: db.prepare('INSERT INTO channels (id, account_id, name, created_at) VALUES (?, ?, ?, ?)'),
  channel: db.prepare('SELECT * FROM channels WHERE id = ? AND account_id = ?'),
  channelsOf: db.prepare('SELECT * FROM channels WHERE account_id = ? ORDER BY created_at'),
  countOf: db.prepare('SELECT COUNT(*) n FROM channels WHERE account_id = ?'),
  all: db.prepare('SELECT * FROM channels'),
  setPhone: db.prepare('UPDATE channels SET phone = ? WHERE id = ?'),
  rename: db.prepare('UPDATE channels SET name = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM channels WHERE id = ?'),
  insertMsg: db.prepare(`INSERT OR IGNORE INTO messages (channel_id, wa_id, chat, chat_name, from_me, sender, type, text, media, status, ts)
                         VALUES (:channel_id, :wa_id, :chat, :chat_name, :from_me, :sender, :type, :text, :media, :status, :ts)`),
  setMsgStatus: db.prepare('UPDATE messages SET status = ? WHERE channel_id = ? AND wa_id = ?'),
};

// ---------- запуск при старте сервера ----------

export async function restoreChannels() {
  const rows = q.all.all();
  for (const row of rows) start(row).catch((err) => logger.error({ err, channel: row.id }, 'не удалось запустить канал'));
  logger.info({ count: rows.length }, 'каналы восстановлены');
}

// ---------- операции для API (всегда в рамках одной компании) ----------

function view(row) {
  const l = live.get(row.id);
  const status = l?.status ?? 'stopped';
  return {
    id: row.id,
    name: row.name,
    status, // starting | qr | connected | reconnecting | logged_out | stopped
    phone: row.phone ?? null,
    qr: status === 'qr' ? l.qrDataUrl : null,
    createdAt: row.created_at,
  };
}

function own(accountId, channelId) {
  const row = q.channel.get(channelId, accountId);
  if (!row) throw httpError(404, 'Канал не найден');
  return row;
}

export const listChannels = (accountId) => q.channelsOf.all(accountId).map(view);
export const getChannel = (accountId, id) => view(own(accountId, id));

export async function createChannel(accountId, name) {
  if (q.countOf.get(accountId).n >= config.maxChannelsPerAccount) {
    throw httpError(403, `Достигнут лимит номеров на тарифе: ${config.maxChannelsPerAccount}`);
  }
  const row = { id: `ch_${randomId(8)}`, account_id: accountId, name: String(name || '').trim().slice(0, 100) || 'WhatsApp', created_at: now() };
  q.insertChannel.run(row.id, row.account_id, row.name, row.created_at);
  await start(row);
  return view(row);
}

export function renameChannel(accountId, id, name) {
  const row = own(accountId, id);
  const clean = String(name || '').trim().slice(0, 100);
  if (!clean) throw httpError(400, 'Название не может быть пустым');
  q.rename.run(clean, id);
  return view({ ...row, name: clean });
}

/** Новый QR для канала, который отвязали на телефоне. */
export async function relinkChannel(accountId, id) {
  const row = own(accountId, id);
  const l = live.get(id);
  if (l?.status === 'connected') throw httpError(409, 'Номер уже подключён');
  await stop(id);
  await fs.rm(path.join(sessionsDir, id), { recursive: true, force: true });
  await start(row);
  return view(row);
}

export async function deleteChannel(accountId, id) {
  own(accountId, id);
  const l = live.get(id);
  if (l) {
    l.stopped = true;
    try { await l.sock?.logout(); } catch { l.sock?.end(undefined); }
    live.delete(id);
  }
  q.remove.run(id);
  await fs.rm(path.join(sessionsDir, id), { recursive: true, force: true });
  await fs.rm(path.join(mediaDir, id), { recursive: true, force: true });
  emit(accountId, 'channel.status', id, { status: 'deleted' });
}

/** Список диалогов с последним сообщением. */
export function listChats(accountId, id, { limit = 50 } = {}) {
  own(accountId, id);
  return db.prepare(`
    SELECT m.chat, m.text AS lastText, m.type AS lastType, m.from_me AS lastFromMe, m.ts AS lastTs,
           (SELECT chat_name FROM messages n WHERE n.channel_id = m.channel_id AND n.chat = m.chat AND n.chat_name IS NOT NULL ORDER BY ts DESC LIMIT 1) AS name
    FROM messages m
    JOIN (SELECT chat, MAX(id) AS last_id FROM messages WHERE channel_id = ? GROUP BY chat) t ON t.last_id = m.id
    ORDER BY m.ts DESC LIMIT ?`).all(id, clampLimit(limit)).map((r) => ({ ...r, lastFromMe: !!r.lastFromMe }));
}

/** История сообщений диалога, от новых к старым; before — курсор (ts). */
export function listMessages(accountId, id, { chat, before, limit = 50 } = {}) {
  own(accountId, id);
  if (!chat) throw httpError(400, 'Параметр chat обязателен');
  const rows = db.prepare(`SELECT * FROM messages WHERE channel_id = ? AND chat = ? AND ts < ? ORDER BY ts DESC LIMIT ?`)
    .all(id, String(chat), Number(before) || Number.MAX_SAFE_INTEGER, clampLimit(limit));
  return rows.map(messageView);
}

function messageView(r) {
  return {
    messageId: r.wa_id,
    chat: r.chat,
    fromMe: !!r.from_me,
    from: r.sender,
    type: r.type,
    text: r.text,
    media: r.media ? JSON.parse(r.media) : null,
    status: r.status,
    timestamp: r.ts,
  };
}

const clampLimit = (n) => Math.min(200, Math.max(1, Number(n) || 50));

/**
 * Отправка. Сообщения одного номера уходят строго по очереди с паузой,
 * чтобы поведение было похоже на живого человека.
 */
export function sendMessage(accountId, id, body) {
  own(accountId, id);
  const l = live.get(id);
  if (l?.status !== 'connected') throw httpError(409, `Номер не подключён (статус: ${l?.status ?? 'stopped'})`);

  const jid = toJid(body.to);
  const content = buildContent(body);

  const job = l.sendChain.then(async () => {
    await pause();
    const sent = await l.sock.sendMessage(jid, content);
    const chat = isJidGroup(jid) ? jid : jidToId(jid);
    const ts = now();
    q.insertMsg.run({
      channel_id: id, wa_id: sent.key.id, chat, chat_name: null, from_me: 1, sender: l.me?.phone ?? null,
      type: body.type || 'text', text: body.text ?? body.caption ?? null,
      media: body.url ? JSON.stringify({ url: body.url, fileName: body.fileName ?? null, mimetype: body.mimetype ?? null }) : null,
      status: 'pending', ts,
    });
    return { messageId: sent.key.id, chat, timestamp: ts };
  });
  l.sendChain = job.catch(() => {});
  return job;
}

// ---------- сокет WhatsApp ----------

async function stop(id) {
  const l = live.get(id);
  if (!l) return;
  l.stopped = true;
  l.sock?.end(undefined);
  live.delete(id);
}

async function start(row) {
  const { id, account_id: accountId } = row;
  const prev = live.get(id);
  const l = prev ?? { status: 'starting', qrDataUrl: null, me: null, sock: null, sendChain: Promise.resolve(), retries: 0 };
  l.stopped = false;
  live.set(id, l);

  const setStatus = (status, extra = {}) => {
    l.status = status;
    emit(accountId, 'channel.status', id, { status, phone: l.me?.phone ?? null, ...extra });
  };

  const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, id));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  if (l.stopped) return;

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger: logger.child({ channel: id, module: 'baileys' }, { level: 'warn' }),
    markOnlineOnConnect: false, // не «гасим» уведомления на телефоне владельца номера
    syncFullHistory: false,
  });
  l.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (sock !== l.sock || l.stopped) return;
    if (u.qr) {
      l.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      setStatus('qr');
    }
    if (u.connection === 'open') {
      l.retries = 0;
      l.qrDataUrl = null;
      const meJid = sock.user?.id;
      l.me = { phone: meJid ? jidToId(jidNormalizedUser(meJid)) : null, name: sock.user?.name ?? null };
      q.setPhone.run(l.me.phone, id);
      setStatus('connected');
      logger.info({ channel: id, accountId, phone: l.me.phone }, 'номер подключён');
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // Устройство отвязали на телефоне — сессия больше не действительна
        await fs.rm(path.join(sessionsDir, id), { recursive: true, force: true });
        l.me = null;
        setStatus('logged_out');
        logger.warn({ channel: id }, 'номер отвязан');
        return;
      }
      l.retries++;
      const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2000 * l.retries);
      setStatus('reconnecting', { reason: code ?? null });
      setTimeout(() => {
        if (!l.stopped && live.get(id) === l) start(row).catch((err) => logger.error({ err, channel: id }, 'переподключение не удалось'));
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // пропускаем синхронизацию старой истории
    for (const msg of messages) {
      try {
        await handleIncoming(accountId, id, l, msg);
      } catch (err) {
        logger.error({ err, channel: id }, 'ошибка обработки сообщения');
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (update.status == null || !key.fromMe) continue;
      const status = STATUS_NAMES[update.status] ?? String(update.status);
      q.setMsgStatus.run(status, id, key.id);
      emit(accountId, 'message.status', id, { messageId: key.id, chat: chatOf(key), status });
    }
  });
}

async function handleIncoming(accountId, channelId, l, msg) {
  const { key } = msg;
  const remote = key.remoteJid;
  if (!msg.message || !remote || remote === 'status@broadcast' || remote.endsWith('@newsletter')) return;

  const group = isJidGroup(remote);
  const chatJid = group ? remote : preferPhoneJid(remote, key.remoteJidAlt);
  const senderJid = group ? preferPhoneJid(key.participant, key.participantAlt) : chatJid;
  const content = unwrap(msg.message);
  const kind = Object.keys(content).find((k) => k !== 'messageContextInfo') || 'unknown';

  const data = {
    messageId: key.id,
    fromMe: !!key.fromMe, // true — менеджер написал прямо с телефона
    chat: chatOf(key),
    isGroup: group,
    from: key.fromMe ? l.me?.phone ?? null : jidToId(senderJid),
    senderName: key.fromMe ? null : msg.pushName ?? null,
    // WhatsApp может скрыть номер (LID) — тогда в chat идентификатор вида 123…@lid
    isLid: isLidUser(chatJid),
    timestamp: Number(msg.messageTimestamp) * 1000 || now(),
    type: 'text',
    text: content.conversation || content.extendedTextMessage?.text || null,
    quotedMessageId: content.extendedTextMessage?.contextInfo?.stanzaId ?? null,
  };

  const mediaKind = MEDIA_TYPES[kind];
  if (mediaKind) {
    const media = content[kind]?.message ? unwrap(content[kind].message) : content;
    const inner = media.documentMessage || media[kind];
    data.type = mediaKind;
    data.text = inner?.caption ?? null;
    data.media = await saveMedia(channelId, l, msg, inner);
  } else if (kind === 'locationMessage') {
    data.type = 'location';
    data.location = { lat: content.locationMessage.degreesLatitude, lng: content.locationMessage.degreesLongitude };
  } else if (kind === 'contactMessage') {
    data.type = 'contact';
    data.text = content.contactMessage.vcard;
  } else if (kind === 'reactionMessage') {
    data.type = 'reaction';
    data.text = content.reactionMessage.text;
    data.quotedMessageId = content.reactionMessage.key?.id ?? null;
  } else if (!data.text) {
    return; // служебные сообщения (протокольные, опросы и т.п.) пока не передаём
  }

  if (data.type !== 'reaction') {
    q.insertMsg.run({
      channel_id: channelId, wa_id: data.messageId, chat: data.chat, chat_name: group ? null : data.senderName,
      from_me: data.fromMe ? 1 : 0, sender: data.from, type: data.type, text: data.text,
      media: data.media ? JSON.stringify(data.media) : data.location ? JSON.stringify(data.location) : null,
      status: data.fromMe ? 'sent' : null, ts: data.timestamp,
    });
  }
  emit(accountId, data.fromMe ? 'message.outgoing' : 'message.incoming', channelId, data);
}

async function saveMedia(channelId, l, msg, info) {
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: l.sock.updateMediaMessage });
    const ext = extFromMime(info?.mimetype) || 'bin';
    const file = `${msg.key.id.replace(/[^a-zA-Z0-9_-]/g, '')}.${ext}`;
    const dir = path.join(mediaDir, channelId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), buf);
    return {
      url: config.publicUrl + signMediaPath(`/media/${channelId}/${file}`),
      mimetype: info?.mimetype ?? null,
      fileName: info?.fileName ?? file,
      size: buf.length,
    };
  } catch (err) {
    logger.warn({ err: err.message, channel: channelId }, 'не удалось скачать медиа');
    return null;
  }
}

// ---------- вспомогательные функции ----------

function unwrap(m) {
  // «Исчезающие» сообщения и «просмотр один раз» приходят во вложенной обёртке
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message;
  return inner ? unwrap(inner) : m;
}

function preferPhoneJid(jid, alt) {
  if (isLidUser(jid) && alt && !isLidUser(alt)) return alt;
  return jid;
}

/** Идентификатор диалога: номер телефона, «…@lid», если номер скрыт, или jid группы. */
function chatOf(key) {
  if (isJidGroup(key.remoteJid)) return key.remoteJid;
  return jidToId(preferPhoneJid(key.remoteJid, key.remoteJidAlt));
}

function jidToId(jid) {
  if (!jid) return null;
  const user = jid.split('@')[0].split(':')[0];
  return isLidUser(jid) ? `${user}@lid` : user;
}

function toJid(to) {
  if (typeof to !== 'string' || !to) throw httpError(400, 'Поле "to" обязательно');
  if (/@(g\.us|lid)$/.test(to)) return to; // группа или скрытый номер
  if (to.includes('@')) throw httpError(400, 'Неверный адрес получателя');
  const digits = to.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw httpError(400, 'Неверный номер: укажите в международном формате, например 79991234567');
  return `${digits}@s.whatsapp.net`;
}

function buildContent(b) {
  const type = b.type || 'text';
  if (type === 'text') {
    if (!b.text) throw httpError(400, 'Поле "text" обязательно');
    return { text: String(b.text).slice(0, 65536) };
  }
  if (!/^https:\/\//i.test(b.url || '')) throw httpError(400, 'Для медиа нужно поле "url" с https-ссылкой');
  const media = { url: b.url };
  switch (type) {
    case 'image': return { image: media, caption: b.caption };
    case 'video': return { video: media, caption: b.caption };
    case 'audio': return { audio: media, mimetype: b.mimetype || 'audio/ogg; codecs=opus', ptt: !!b.voice };
    case 'document':
      return { document: media, fileName: b.fileName || 'file', mimetype: b.mimetype || 'application/octet-stream', caption: b.caption };
    default: throw httpError(400, `Неизвестный тип "${type}"`);
  }
}

function extFromMime(mime) {
  if (!mime) return null;
  const base = mime.split(';')[0].trim();
  const map = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'application/pdf': 'pdf' };
  return map[base] || base.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 10) || null;
}

function pause() {
  const [min, max] = config.sendDelayMs;
  return new Promise((r) => setTimeout(r, min + Math.random() * Math.max(0, max - min)));
}
