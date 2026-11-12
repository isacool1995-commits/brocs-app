// Общие помощники серверных функций: запросы к Supabase с секретным ключом и проверка вошедшего.
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(path, opt = {}) {
  const r = await fetch(URL_ + path, {
    ...opt,
    headers: { apikey: SRV, Authorization: 'Bearer ' + SRV, 'Content-Type': 'application/json', ...(opt.headers || {}) }
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { ok: r.ok, status: r.status, body };
}

async function caller(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(URL_ + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
}

async function getDoc(col, id) {
  const r = await sb('/rest/v1/docs?col=eq.' + encodeURIComponent(col) + '&id=eq.' + encodeURIComponent(id) + '&select=data');
  return Array.isArray(r.body) && r.body[0] ? r.body[0].data : null;
}

function putDoc(col, id, data) {
  return sb('/rest/v1/docs?on_conflict=col,id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ col, id, data })
  });
}

const isAdmin = m => !!m && !m.blocked && (m.access === 'r_admin' || (!m.access && m.role === 'Руководитель'));

function body(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

module.exports = { URL_, ANON, SRV, sb, caller, getDoc, putDoc, isAdmin, body, configured: () => !!(URL_ && ANON && SRV) };
