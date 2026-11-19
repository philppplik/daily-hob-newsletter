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
  if (old && old.confirmedAt && !old.unsubscribedAt) {
    // Bestaetigter Bestandsleser: keine Enumeration. Ausnahme analog KIFB:
    // zusaetzliches Wochenrueckblick-Opt-in, Guards+Drosselung im CAS-Claim.
    if (b.nl === true) {
      const THROTTLE_MS = 10 * 60 * 1000;
      const claim = await IW.iwStore.mutateCas(id, (r) => {
        if (!r.confirmedAt || r.unsubscribedAt) return false;
        if (r.nlOptIn === true) return false;
        if (r.nlUnsub && r.nlUnsub.iw) return false;
        const last = Date.parse(r.nlWeeklyReqAt || 0) || 0;
        if (last && Date.now() - last < THROTTLE_MS) return false;
        r.nlWeeklyReqAt = new Date().toISOString();
      });
      if (claim.ok) {
        const t = L.token('doi-nl-iw', id, 48 * 3600);
        const link = L.apiUrl('/lw/api/confirm?s=iw&t=' + encodeURIComponent(t));
        await L.sendMail({
          to: email,
          from: IW.IW_FROM,
          replyTo: null,
          subject: 'Bitte bestätigen: Wochenrückblick von Intelligenz Welt',
          text: 'Hallo,\n\ndu hast bereits Zugang zur täglichen Tagesausgabe von Intelligenz Welt. Bitte bestätige jetzt die zusätzliche Anmeldung zum Wochenrückblick:\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du die Anmeldung nicht angefordert hast, ignoriere diese E-Mail, es passiert nichts.\n\nVersand über Resend (PLUS FIVE FIVE, Inc., USA). Datenschutz: ' + IW.SITE_IW + '/datenschutz\nIntelligenz Welt, Philipp Paulik, ' + IW.SITE_IW + '/impressum\n',
          html: '<p>Hallo,</p><p>du hast bereits Zugang zur täglichen Tagesausgabe von Intelligenz Welt. Bitte bestätige jetzt die zusätzliche Anmeldung zum Wochenrückblick:</p><p><a href="' + link + '">Wochenrückblick bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du die Anmeldung nicht angefordert hast, ignoriere diese E-Mail, es passiert nichts.</p><p style="color:#666;font-size:12px">Versand über Resend (PLUS FIVE FIVE, Inc., USA). <a href="' + IW.SITE_IW + '/datenschutz">Datenschutz</a> · <a href="' + IW.SITE_IW + '/impressum">Impressum</a></p>'
        });
      }
    }
    return L.json(res, 200, { ok: true }); // keine Enumeration
  }
  const nl = b.nl === true; // separate, optional weekly opt-in
  const rec = { email, source: 'iw', signupAt: new Date().toISOString(), signupIp: L.ip(req), textVersion: IW.IW_TEXT_VERSION, nlOptIn: nl, confirmedAt: null, confirmIp: null, unsubscribedAt: null };
  await IW.iwStore.put(id, rec);
  const t = L.token('doi-iw', id, 48 * 3600);
  const link = L.apiUrl('/lw/api/confirm?s=iw&t=' + encodeURIComponent(t));
  await L.sendMail({
    to: email,
    from: IW.IW_FROM,
    replyTo: null, // keine ungepruefte IW-Antwortadresse erfinden
    subject: 'Bitte bestätigen: Tagesausgabe' + (nl ? ' und Wochenrückblick' : '') + ' von Intelligenz Welt',
    text: 'Hallo,\n\nbitte bestätige deine Anmeldung zum kostenlosen PDF-Zugang zur täglichen Tagesausgabe' + (nl ? ' und zum Wochenrückblick' : '') + ' von Intelligenz Welt:\n\n' + link + '\n\nDer Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.\n\nVersand über Resend (PLUS FIVE FIVE, Inc., USA). Datenschutz: ' + IW.SITE_IW + '/datenschutz\nIntelligenz Welt, Philipp Paulik, ' + IW.SITE_IW + '/impressum\n',
    html: '<p>Hallo,</p><p>bitte bestätige deine Anmeldung zum kostenlosen PDF-Zugang zur täglichen Tagesausgabe' + (nl ? ' und zum Wochenrückblick' : '') + ' von Intelligenz Welt:</p><p><a href="' + link + '">Anmeldung bestätigen</a></p><p>Der Link ist 48 Stunden gültig. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail, es passiert nichts.</p><p style="color:#666;font-size:12px">Versand über Resend (PLUS FIVE FIVE, Inc., USA). <a href="' + IW.SITE_IW + '/datenschutz">Datenschutz</a> · <a href="' + IW.SITE_IW + '/impressum">Impressum</a></p>'
  });
  L.json(res, 200, { ok: true });
};
