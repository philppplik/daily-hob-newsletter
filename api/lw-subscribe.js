'use strict';
const L = require('./_lw');
// POST {email, consent:true, website:''}  ->  DOI mail only. No PDF before confirmation.
module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== 'POST') return L.json(res, 405, { ok: false });
  let b; try { b = await L.readBody(req); } catch (e) { return L.json(res, 400, { ok: false }); }
  if (b.website) return L.json(res, 200, { ok: true }); // honeypot, tell bots nothing
  const email = L.norm(b.email);
  if (!L.validEmail(email)) return L.json(res, 400, { ok: false, error: 'email' });
  if (b.consent !== true) return L.json(res, 400, { ok: false, error: 'consent' });
  const id = L.idOf(email);
  const old = await L.store.get(id);
  if (old && old.confirmedAt && !old.unsubscribedAt) return L.json(res, 200, { ok: true }); // same answer, no enumeration
  const rec = { email, signupAt: new Date().toISOString(), signupIp: L.ip(req), textVersion: L.TEXT_VERSION, confirmedAt: null, confirmIp: null, unsubscribedAt: null };
  await L.store.put(id, rec);
  const t = L.token('doi', id, 48 * 3600);
  const link = L.API + '/api/confirm?t=' + encodeURIComponent(t);
  await L.sendMail({
    to: email,
    subject: 'Bitte bestätigen: KI-Tagesbericht des KI Fachblatts',
    text: 'Hallo,\n\nbitte bestätige deine Anmeldung zum kostenlosen KI-Tagesbericht des KI Fachblatts:\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.\n\nVersand über Resend (USA) als Auftragsverarbeiter. Datenschutz: ' + L.SITE + '/datenschutz\nKI Fachblatt, Philipp Paulik, ' + L.SITE + '/impressum\n',
    html: '<p>Hallo,</p><p>bitte bestätige deine Anmeldung zum kostenlosen KI-Tagesbericht des KI Fachblatts:</p><p><a href="' + link + '">Anmeldung bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.</p><p style="color:#666;font-size:12px">Versand über Resend (USA) als Auftragsverarbeiter. <a href="' + L.SITE + '/datenschutz">Datenschutz</a> · <a href="' + L.SITE + '/impressum">Impressum</a></p>'
  });
  L.json(res, 200, { ok: true });
};
