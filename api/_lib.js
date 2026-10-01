const crypto = require('crypto');
const SITE = 'https://hob.philipp-paulik.de';
const FROM = 'Daily Hob <briefing@hob.philipp-paulik.de>';
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', process.env.SECRET).update(payload).digest('base64url');
function makeToken(email, ttlMs = 48 * 3600 * 1000) {
  const p = b64(JSON.stringify({ e: email, x: Date.now() + ttlMs }));
  return p + '.' + sign(p);
}
function readToken(token) {
  const [p, s] = String(token || '').split('.');
  if (!p || !s) return null;
  const good = sign(p);
  const a = Buffer.from(s), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!d.e || Date.now() > d.x) return null;
    return d.e;
  } catch { return null; }
}
async function resend(path, body, method = 'POST') {
  const r = await fetch('https://api.resend.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, json };
}
module.exports = { SITE, FROM, makeToken, readToken, resend };
