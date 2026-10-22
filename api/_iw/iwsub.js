'use strict';
const L = require('../_lw');
const IW = require('./iwlib');
// POST {email, consent:true, website:''} -> nur DOI-Mail. Kein PDF vor Bestaetigung.
module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== 'POST') return L.json(res, 405, { ok: false });
  let b; try { b = await L.readBody(req); } catch (e) { return L.json(res, 400, { ok: false }); }
  if (b.website) return L.json(res, 200, { ok: true }); // honeypot
  const email = L.norm(b.email);
  if (!L.validEmail(email)) return L.json(res, 400, { ok: false, error: 'email' });
  if (b.consent !== true) return L.json(res, 400, { ok: false, error: 'consent' });
  const id = L.idOf(email);
  const old = await IW.iwStore.get(id);
  if (old && old.confirmedAt && !old.unsubscribedAt) return L.json(res, 200, { ok: true }); // keine Enumeration
  const rec = { email, source: 'iw', signupAt: new Date().toISOString(), signupIp: L.ip(req), textVersion: IW.IW_TEXT_VERSION, confirmedAt: null, confirmIp: null, unsubscribedAt: null };
  await IW.iwStore.put(id, rec);
  const t = L.token('doi-iw', id, 48 * 3600);
  const link = L.API + '/api/confirm?s=iw&t=' + encodeURIComponent(t);
  await L.sendMail({
    to: email,
    from: IW.IW_FROM,
    replyTo: null, // keine ungepruefte IW-Antwortadresse erfinden
    subject: 'Bitte bestätigen: Tagesbericht von Intelligenz Welt',
    text: 'Hallo,\n\nbitte bestätige deine Anmeldung zum kostenlosen PDF-Zugang zur täglichen Tagesausgabe von Intelligenz Welt:\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.\n\nVersand über Resend (USA) als Auftragsverarbeiter. Datenschutz: ' + IW.SITE_IW + '/datenschutz\nIntelligenz Welt, Philipp Paulik, ' + IW.SITE_IW + '/impressum\n',
    html: '<p>Hallo,</p><p>bitte bestätige deine Anmeldung zum kostenlosen PDF-Zugang zur täglichen Tagesausgabe von Intelligenz Welt:</p><p><a href="' + link + '">Anmeldung bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.</p><p style="color:#666;font-size:12px">Versand über Resend (USA) als Auftragsverarbeiter. <a href="' + IW.SITE_IW + '/datenschutz">Datenschutz</a> · <a href="' + IW.SITE_IW + '/impressum">Impressum</a></p>'
  });
  L.json(res, 200, { ok: true });
};
