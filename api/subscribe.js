const { SITE, FROM, makeToken, resend } = require('./_lib');
const hits = new Map(); // best-effort rate limit per warm instance
const ALLOWED = new Set([SITE, 'https://philppplik.github.io']);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function cors(req, res) {
  const o = req.headers.origin;
  if (ALLOWED.has(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!ALLOWED.has(req.headers.origin)) return res.status(403).json({ ok: false });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= 5) return res.status(429).json({ ok: false, error: 'rate' });
  list.push(now); hits.set(ip, list);

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (body.website) return res.status(200).json({ ok: true }); // honeypot: pretend success
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || body.consent !== true) return res.status(400).json({ ok: false, error: 'invalid' });

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const link = `https://${host}/api/confirm?token=${makeToken(email)}`;
  const text = `Hallo,\n\nbitte bestätige deine Anmeldung zum Daily-Hob-Newsletter (Hob Friday Signal und Hob Monday Rewind), indem du auf diesen Link klickst:\n\n${link}\n\nDer Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail einfach. Dann passiert nichts und wir speichern nichts.\n\nDaily Hob\n${SITE}/impressum · ${SITE}/datenschutz\n`;
  const r = await resend('/emails', { from: FROM, to: [email], subject: 'Bitte bestätige deine Anmeldung zum Daily Hob', text });
  if (!r.ok) return res.status(502).json({ ok: false, error: 'send' });
  return res.status(200).json({ ok: true });
};
