'use strict';
const L = require('../_lw');
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
  if (old && old.confirmedAt && !old.unsubscribedAt) {
    // Bestaetigter Bestandsleser: kein erneutes Tagesbericht-DOI (keine Enumeration).
    // Ausnahme: zusaetzliches Wochenrueckblick-Opt-in (nl). Drosselung und Guards
    // (bestaetigt, nicht abgemeldet, noch kein nlOptIn, kein frueheres Weekly-Unsub)
    // stehen IM CAS-Claim, damit nebenlaeufige Anmeldungen genau eine Mail erzeugen.
    // Abgemeldete Wochenleser (nlUnsub.kifb) werden hier bewusst NICHT re-aktiviert
    // (dokumentierter Restfall, kein automatischer Re-Opt-in-Pfad).
    if (b.nl === true) {
      const THROTTLE_MS = 10 * 60 * 1000;
      const claim = await L.store.mutateCas(id, (r) => {
        if (!r.confirmedAt || r.unsubscribedAt) return false;
        if (r.nlOptIn === true) return false;
        if (r.nlUnsub && r.nlUnsub.kifb) return false;
        const last = Date.parse(r.nlWeeklyReqAt || 0) || 0;
        if (last && Date.now() - last < THROTTLE_MS) return false;
        r.nlWeeklyReqAt = new Date().toISOString();
      });
      if (claim.ok) {
        const t = L.token('doi-nl', id, 48 * 3600);
        const link = L.apiUrl('/lw/api/confirm?t=' + encodeURIComponent(t));
        await L.sendMail({
          to: email,
          subject: 'Bitte bestätigen: Wochenrückblick des KI Fachblatts',
          text: 'Hallo,\n\ndu erhältst bereits den KI-Tagesbericht des KI Fachblatts. Bitte bestätige jetzt die zusätzliche Anmeldung zum Wochenrückblick:\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du die Anmeldung nicht angefordert hast, ignoriere diese E-Mail, es passiert nichts.\n\nVersand über Resend (PLUS FIVE FIVE, Inc., USA). Datenschutz: ' + L.SITE + '/datenschutz\nKI Fachblatt, Philipp Paulik, ' + L.SITE + '/impressum\n',
          html: '<p>Hallo,</p><p>du erhältst bereits den KI-Tagesbericht des KI Fachblatts. Bitte bestätige jetzt die zusätzliche Anmeldung zum Wochenrückblick:</p><p><a href="' + link + '">Wochenrückblick bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du die Anmeldung nicht angefordert hast, ignoriere diese E-Mail, es passiert nichts.</p><p style="color:#666;font-size:12px">Versand über Resend (PLUS FIVE FIVE, Inc., USA). <a href="' + L.SITE + '/datenschutz">Datenschutz</a> · <a href="' + L.SITE + '/impressum">Impressum</a></p>'
        });
      }
    }
    return L.json(res, 200, { ok: true }); // same answer, no enumeration
  }
  const nl = b.nl === true; // separate, optional weekly opt-in (own checkbox)
  const rec = { email, signupAt: new Date().toISOString(), signupIp: L.ip(req), textVersion: L.TEXT_VERSION, nlOptIn: nl, confirmedAt: null, confirmIp: null, unsubscribedAt: null };
  await L.store.put(id, rec);
  const t = L.token('doi', id, 48 * 3600);
  const link = L.apiUrl('/lw/api/confirm?t=' + encodeURIComponent(t));
  await L.sendMail({
    to: email,
    subject: 'Bitte bestätigen: KI-Tagesbericht' + (nl ? ' und Wochenrückblick' : '') + ' des KI Fachblatts',
    text: 'Hallo,\n\nbitte bestätige deine Anmeldung zum kostenlosen KI-Tagesbericht' + (nl ? ' und Wochenrückblick' : '') + ' des KI Fachblatts:\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.\n\nVersand über Resend (PLUS FIVE FIVE, Inc., USA). Datenschutz: ' + L.SITE + '/datenschutz\nKI Fachblatt, Philipp Paulik, ' + L.SITE + '/impressum\n',
    html: '<p>Hallo,</p><p>bitte bestätige deine Anmeldung zum kostenlosen KI-Tagesbericht' + (nl ? ' und Wochenrückblick' : '') + ' des KI Fachblatts:</p><p><a href="' + link + '">Anmeldung bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.</p><p style="color:#666;font-size:12px">Versand über Resend (PLUS FIVE FIVE, Inc., USA). <a href="' + L.SITE + '/datenschutz">Datenschutz</a> · <a href="' + L.SITE + '/impressum">Impressum</a></p>'
  });
  L.json(res, 200, { ok: true });
};
