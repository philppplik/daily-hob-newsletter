'use strict';
const L = require('../_lw');
const IW = require('../_iw/iwlib');
const FA = require('../_fa/falib');
// GET ?t=<doi token>[&s=tk|atlas|iw] -> mark confirmed, redirect to the thank-you page with a download token in the URL fragment.
// IW laeuft mit eigenen Records (optin-iw/), eigenen Token-Zwecken (doi-iw/dl-iw) und eigener Site.
// FA: reines Newsletter-Produkt (Wochenrueckblick), eigene Records (optin-fa/).
// Weekly provider sync after confirm: applies the fresh consent exactly once via the
// durable state machine in newsletter/audience-sync.js (marker before any external
// call, opt-in last, unknown never blind-retried). Recoverable: failures land on the
// record (nlSync.state) instead of throwing a 500 after confirmedAt was persisted.
async function syncWeekly(L, rec, site) {
  if (rec.nlOptIn !== true) return;
  try {
    const sync = require('../../newsletter/audience-sync');
    const store = site === 'fa' ? require('../_fa/falib').faStore : site === 'iw' ? require('../_iw/iwlib').iwStore : L.store;
    await sync.applyConsent({ L, store, site }, rec);
  } catch (e) {
    try {
      const store = site === 'fa' ? require('../_fa/falib').faStore : site === 'iw' ? require('../_iw/iwlib').iwStore : L.store;
      await store.mutateCas(L.idOf(rec.email), (r) => {
        r.nlSync = { consentAt: rec.confirmedAt || null, state: 'unknown', error: String(e && e.message || e), at: new Date().toISOString() };
      }).catch(() => {});
    } catch (e2) { /* marker write failed before any external call: safe */ }
  }
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const t = url.searchParams.get('t');
  const s = url.searchParams.get('s');
  if (s === 'fa') {
    const id = L.verify('doi-fa', t);
    if (!id) return L.redirect(res, FA.SITE_FA + '/newsletter-bestaetigt/?e=1');
    const rec = await FA.faStore.get(id);
    if (!rec) return L.redirect(res, FA.SITE_FA + '/newsletter-bestaetigt/?e=1');
    if (!rec.confirmedAt) { const m = await FA.faStore.mutateCas(id, (r) => { r.confirmedAt = r.confirmedAt || new Date().toISOString(); r.confirmIp = L.ip(req); r.unsubscribedAt = null; }); await syncWeekly(L, (m.ok ? m.rec : rec), 'fa'); } // Wochenrueckblick-Eligibility kommt aus dem eigenen Record (nlOptIn), kein Resend-Segment
    return L.redirect(res, FA.SITE_FA + '/newsletter-bestaetigt/');
  }
  if (s === 'iw') {
    // Weekly add-on DOI (IW): nur Weekly-Felder, Tagesausgabe-Nachweis bleibt unangetastet.
    const idIwNl = L.verify('doi-nl-iw', t);
    if (idIwNl) {
      // Weekly add-on DOI (IW): exakt wie der KIFB-Zweig — alle Guards IM CAS
      // (bestaetigt, nicht abgemeldet, kein frueheres Weekly-Unsub, noch nicht
      // angewendet); Erstnachweis (nlOptInConfirmedAt/nlConfirmIp/nlTextVersion)
      // bleibt bei Replay unveraendert; Tagesausgabe-Nachweis nie angeruehrt.
      const mIwNl = await IW.iwStore.mutateCas(idIwNl, (r) => {
        if (!r.confirmedAt || r.unsubscribedAt) return false;
        if (r.nlUnsub && r.nlUnsub.iw) return false;
        if (r.nlOptIn === true) return false; // bereits angewendet, Erstnachweis bleibt
        r.nlOptIn = true;
        if (!r.nlOptInConfirmedAt) { r.nlOptInConfirmedAt = new Date().toISOString(); r.nlConfirmIp = L.ip(req); r.nlTextVersion = IW.IW_TEXT_VERSION; }
      });
      if (mIwNl.ok) { await syncWeekly(L, mIwNl.rec, 'iw'); return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt?nl=1'); }
      const curIwNl = mIwNl.rec || await IW.iwStore.get(idIwNl);
      if (curIwNl && curIwNl.confirmedAt && !curIwNl.unsubscribedAt && curIwNl.nlOptIn === true) return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt?nl=1');
      return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt?e=1');
    }
    const id = L.verify('doi-iw', t);
    if (!id) return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt?e=1');
    const rec = await IW.iwStore.get(id);
    if (!rec) return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt?e=1');
    if (!rec.confirmedAt) { const m = await IW.iwStore.mutateCas(id, (r) => { r.confirmedAt = r.confirmedAt || new Date().toISOString(); r.confirmIp = L.ip(req); r.unsubscribedAt = null; }); await syncWeekly(L, (m.ok ? m.rec : rec), 'iw'); } // Weekly-Sync nur bei separatem nlOptIn
    const dl = L.token('dl-iw', id, 0);
    return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt#k=' + dl); // Fragment: geht nicht an Server oder Logs
  }
  // Weekly add-on DOI (KIFB): Guards IM CAS (bestaetigt, nicht abgemeldet, noch kein
  // nlOptIn, kein frueheres Weekly-Unsub); der Tagesbericht-Einwilligungsnachweis
  // (confirmedAt/confirmIp/unsubscribedAt) wird nie angeruehrt; bei Replay bleibt der
  // erste Wochen-Nachweis (nlOptInConfirmedAt/nlConfirmIp/nlTextVersion) unveraendert.
  const idNl = L.verify('doi-nl', t);
  if (idNl) {
    const mNl = await L.store.mutateCas(idNl, (r) => {
      if (!r.confirmedAt || r.unsubscribedAt) return false;
      if (r.nlUnsub && r.nlUnsub.kifb) return false;
      if (r.nlOptIn === true) return false; // bereits angewendet, Erstnachweis bleibt
      r.nlOptIn = true;
      if (!r.nlOptInConfirmedAt) { r.nlOptInConfirmedAt = new Date().toISOString(); r.nlConfirmIp = L.ip(req); r.nlTextVersion = L.TEXT_VERSION; }
    });
    if (mNl.ok) { await syncWeekly(L, mNl.rec, 'kifb'); return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?nl=1'); }
    const curNl = mNl.rec || await L.store.get(idNl);
    if (curNl && curNl.confirmedAt && !curNl.unsubscribedAt && curNl.nlOptIn === true) return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?nl=1');
    return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?e=1');
  }
  const id = L.verify('doi', t);
  const page0 = s === 'tk' ? '/toolkit-bestaetigt' : s === 'atlas' ? '/atlas-daten-bestaetigt' : '/tagesbericht-bestaetigt';
  if (!id) return L.redirect(res, L.SITE + page0 + '?e=1');
  const rec = await L.store.get(id);
  if (!rec) return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?e=1');
  if (!rec.confirmedAt) { const m = await L.store.mutateCas(id, (r) => { r.confirmedAt = r.confirmedAt || new Date().toISOString(); r.confirmIp = L.ip(req); r.unsubscribedAt = null; }); const rec2 = m.ok ? m.rec : rec; if (rec.source !== 'atlas') { await L.addToSegment(rec.email); await syncWeekly(L, rec2, 'kifb'); } } // atlas consent covers the data package only: kein Segment, kein Newsletter
  const dl = L.token('dl', id, 0);
  const page = s === 'tk' ? '/toolkit-bestaetigt' : s === 'atlas' ? '/atlas-daten-bestaetigt' : '/tagesbericht-bestaetigt';
  L.redirect(res, L.SITE + page + '#k=' + dl); // fragment: not sent to servers or logs
};
