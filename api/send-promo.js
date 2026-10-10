const crypto = require('crypto');
const { SITE, FROM, resend } = require('./_lib');

// Admin-only: sends one promo broadcast to the confirmed "Daily Hob" segment.
// Auth: Authorization: Bearer <ADMIN_SEND_KEY> (env var, set only in Vercel).
// GET/POST with ?dry=1 only reports the recipient count and sends nothing.
const SUBJECT = 'Neu im Daily Hob: das Gratis-Dossier "Die Entscheider-Welle"';
const HTML = `<div style="font-family:Arial,Helvetica,sans-serif;color:#141414;max-width:560px;line-height:1.55;font-size:15px">
<p style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#606060;margin:0 0 10px">Daily Hob Dossier</p>
<h2 style="font-size:26px;letter-spacing:-.03em;margin:0 0 12px">Die Entscheider-Welle.</h2>
<p>Kleine Modelle, die nicht erzählen, sondern wählen. Cloudflare Clef, AWS Strands Decider 2B, OpenAI Decisions API und Liquid d1: 9 Seiten Daily-Hob-Dossier, kostenlos als PDF.</p>
<p><a href="${SITE}/dossier-danke" style="display:inline-block;background:#f6c744;color:#141414;text-decoration:none;font-weight:700;padding:10px 18px">Dossier öffnen</a></p>
<p style="color:#606060;font-size:13px;border-top:1px solid #ccc;padding-top:10px;margin-top:22px">Du bekommst diese Mail, weil du dich für den Daily-Hob-Newsletter angemeldet und bestätigt hast. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Abmelden</a> · <a href="${SITE}/impressum">Impressum</a> · <a href="${SITE}/datenschutz">Datenschutz</a></p>
</div>`;
const TEXT = `Die Entscheider-Welle: das neue Gratis-Dossier vom Daily Hob.\n\nKleine Modelle, die nicht erzählen, sondern wählen. 9 Seiten als PDF:\n${SITE}/dossier-danke\n\nDu bekommst diese Mail, weil du dich für den Daily-Hob-Newsletter angemeldet und bestätigt hast. Abmelden: {{{RESEND_UNSUBSCRIBE_URL}}}\n${SITE}/impressum · ${SITE}/datenschutz\n`;

module.exports = async (req, res) => {
  const key = process.env.ADMIN_SEND_KEY || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const a = Buffer.from(got), b = Buffer.from(key);
  if (!key || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false });
  const segment = process.env.SEGMENT_ID;
  const q = req.query || {};
  // count confirmed, still-subscribed contacts in the segment
  let n = 0, cursor = null, pages = 0;
  const names = [];
  do {
    const r = await resend('/contacts?limit=100&segment_id=' + segment + (cursor ? '&after=' + cursor : ''), null, 'GET');
    if (!r.ok) return res.status(502).json({ ok: false, step: 'contacts', status: r.status });
    for (const c of (r.json && r.json.data) || []) { if (!c.unsubscribed) { n++; names.push(c.email.replace(/^(.).*(@.*)$/, '$1***$2')); } cursor = c.id; }
    pages++;
    if (!(r.json && r.json.has_more)) cursor = null;
  } while (cursor && pages < 20);
  if (q.dry === '1' || req.method === 'GET') return res.status(200).json({ ok: true, dry: true, subscribed_contacts_total: n, masked: names });
  const c = await resend('/broadcasts', { segment_id: segment, from: FROM, subject: SUBJECT, html: HTML, text: TEXT, name: 'Dossier Entscheider-Welle Promo', send: true });
  return res.status(c.ok ? 200 : 502).json({ ok: c.ok, status: c.status, id: c.json && c.json.id, error: c.ok ? undefined : c.json });
};
