'use strict';
const L = require('../_lw');
const FA = require('../_fa/falib');

const sub = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== 'POST') return L.json(res, 405, { ok: false });
  let b; try { b = await L.readBody(req); } catch (e) { return L.json(res, 400, { ok: false }); }
  if (b.website) return L.json(res, 200, { ok: true }); // honeypot
  const email = L.norm(b.email);
  if (!L.validEmail(email)) return L.json(res, 400, { ok: false, error: 'email' });
  if (b.consent !== true) return L.json(res, 400, { ok: false, error: 'consent' });
  if (!FA.FA_FROM) return L.json(res, 503, { ok: false, error: 'sender-unresolved' });
  const id = L.idOf(email);
  const old = await FA.faStore.get(id);
  if (old && old.confirmedAt && !old.unsubscribedAt) return L.json(res, 200, { ok: true }); // keine Enumeration
  const rec = { email, source: 'fa-nl', signupAt: new Date().toISOString(), signupIp: L.ip(req), textVersion: FA.FA_TEXT_VERSION, nlOptIn: true, confirmedAt: null, confirmIp: null, unsubscribedAt: null }; // Produkt ist der Newsletter selbst
  await FA.faStore.put(id, rec);
  const t = L.token('doi-fa', id, 48 * 3600);
  const link = L.apiUrl('/lw/api/confirm?s=fa&t=' + encodeURIComponent(t));
  await L.sendMail({
    to: email,
    from: FA.FA_FROM,
    replyTo: null,
    subject: 'Bitte bestätigen: Wochenrückblick von finanzadjust',
    text: 'Hallo,\n\nbitte bestätige deine Anmeldung zum kostenlosen Wochenrückblick von finanzadjust (sonntags per E-Mail):\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.\n\nVersand über Resend (PLUS FIVE FIVE, Inc., USA). Datenschutz: ' + FA.SITE_FA + '/datenschutz/\nfinanzadjust, Philipp Paulik, ' + FA.SITE_FA + '/impressum/\n',
    html: '<p>Hallo,</p><p>bitte bestätige deine Anmeldung zum kostenlosen Wochenrückblick von finanzadjust (sonntags per E-Mail):</p><p><a href="' + link + '">Anmeldung bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.</p><p style="color:#666;font-size:12px">Versand über Resend (PLUS FIVE FIVE, Inc., USA). <a href="' + FA.SITE_FA + '/datenschutz/">Datenschutz</a> · <a href="' + FA.SITE_FA + '/impressum/">Impressum</a></p>'
  });
  L.json(res, 200, { ok: true });
};

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';
  if (action === 'sub') return sub(req, res);
  return L.json(res, 404, { ok: false });
};
