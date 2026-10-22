'use strict';
const L = require('./_lw');
// POST {email, consent:true, website:''} -> DOI mail (new) or download-link mail (already confirmed). No download before confirmation.
const FOOT_T = '\n\nVersand über Resend (USA) als Auftragsverarbeiter. Datenschutz: ' + L.SITE + '/datenschutz\nKI Fachblatt, Philipp Paulik, ' + L.SITE + '/impressum\n';
const FOOT_H = '<p style="color:#666;font-size:12px">Versand über Resend (USA) als Auftragsverarbeiter. <a href="' + L.SITE + '/datenschutz">Datenschutz</a> · <a href="' + L.SITE + '/impressum">Impressum</a></p>';
module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== 'POST') return L.json(res, 405, { ok: false });
  let b; try { b = await L.readBody(req); } catch (e) { return L.json(res, 400, { ok: false }); }
  if (b.website) return L.json(res, 200, { ok: true });
  const email = L.norm(b.email);
  if (!L.validEmail(email)) return L.json(res, 400, { ok: false, error: 'email' });
  if (b.consent !== true) return L.json(res, 400, { ok: false, error: 'consent' });
  const id = L.idOf(email);
  const old = await L.store.get(id);
  if (old && old.confirmedAt && !old.unsubscribedAt) {
    // Already confirmed: same answer on screen, the download link goes only to the mailbox owner.
    const link = L.SITE + '/atlas-daten-bestaetigt#k=' + L.token('dl', id, 0);
    await L.sendMail({ to: email, subject: 'Dein Download: Modell-Atlas-Datenpaket des KI Fachblatts',
      text: 'Hallo,\n\nhier ist dein Download-Link zum kostenlosen Modell-Atlas-Datenpaket des KI Fachblatts (PDF-Auswertung, CSV und JSON):\n\n' + link + '\n\nWenn du das nicht angefordert hast, ignoriere diese E-Mail.' + FOOT_T,
      html: '<p>Hallo,</p><p>hier ist dein Download-Link zum kostenlosen Modell-Atlas-Datenpaket des KI Fachblatts (PDF-Auswertung, CSV und JSON):</p><p><a href="' + link + '">Datenpaket herunterladen</a></p><p>Wenn du das nicht angefordert hast, ignoriere diese E-Mail.</p>' + FOOT_H });
    return L.json(res, 200, { ok: true });
  }
  const rec = { email, signupAt: new Date().toISOString(), signupIp: L.ip(req), textVersion: L.ATLAS_TEXT_VERSION, source: 'atlas', confirmedAt: null, confirmIp: null, unsubscribedAt: null };
  await L.store.put(id, rec);
  const t = L.token('doi', id, 48 * 3600);
  const link = L.API + '/api/confirm?s=atlas&t=' + encodeURIComponent(t);
  await L.sendMail({ to: email, subject: 'Bitte bestätigen: Modell-Atlas-Datenpaket des KI Fachblatts',
    text: 'Hallo,\n\nbitte bestätige deine Anmeldung, damit du das kostenlose Modell-Atlas-Datenpaket des KI Fachblatts herunterladen kannst:\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.' + FOOT_T,
    html: '<p>Hallo,</p><p>bitte bestätige deine Anmeldung, damit du das kostenlose Modell-Atlas-Datenpaket des KI Fachblatts herunterladen kannst:</p><p><a href="' + link + '">Anmeldung bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.</p>' + FOOT_H });
  L.json(res, 200, { ok: true });
};
