// Общее для мессенджеров (Profit Bot): телефоны, поиск контакта и сделки, запись сообщений.
const { sb, getDoc, putDoc } = require('./_sb');

const CHANNELS = { whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX' };
const digits = s => String(s || '').replace(/\D/g, '');
function normPhone(p) {
  let d = digits(p);
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length >= 10 ? d : '';
}

async function findContact(channel, phone, chatId) {
  const ors = [];
  if (phone) ors.push('data->>phoneNorm.eq.' + phone, 'data->>phone.eq.' + phone, 'data->>phone.eq.%2B' + phone);
  if (chatId) ors.push('data->>chat_' + channel + '.eq.' + encodeURIComponent('"' + chatId + '"'));
  if (!ors.length) return null;
  const r = await sb('/rest/v1/docs?col=eq.contacts&select=id,data&limit=1&or=(' + ors.join(',') + ')');
  return Array.isArray(r.body) && r.body[0] ? { id: r.body[0].id, data: r.body[0].data } : null;
}

async function openDealFor(contactId) {
  const r = await sb('/rest/v1/docs?col=eq.deals&select=id,data&data->>contact=eq.' + encodeURIComponent(contactId));
  const rows = (Array.isArray(r.body) ? r.body : []).filter(x => x.data && x.data.stage !== 'won' && x.data.stage !== 'lost');
  rows.sort((a, b) => String(b.data.updatedAt || '').localeCompare(String(a.data.updatedAt || '')));
  return rows[0] ? { id: rows[0].id, data: rows[0].data } : null;
}

async function firstStage() {
  const p = await getDoc('pipelines', 'main');
  return p && Array.isArray(p.stages) && p.stages[0] ? p.stages[0].id : 's_new';
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Номера Profit Bot, с которыми работает «Брокс». Остальные номера аккаунта (например, подключённые к amoCRM) пропускаем.
const NUMBERS = String(process.env.PROFITBOT_NUMBERS || process.env.PROFITBOT_FROM || '')
  .split(/[,;\s]+/).map(digits).filter(Boolean);
const ourNumber = phone => !NUMBERS.length || NUMBERS.includes(digits(phone));

module.exports = { CHANNELS, NUMBERS, ourNumber, digits, normPhone, findContact, openDealFor, firstStage, newId, sb, getDoc, putDoc };
