'use strict';
const L = require('./_lw');
const IW = require('./_iw/iwlib');
// GET ?t=<doi token>[&s=tk|atlas|iw] -> mark confirmed, redirect to the thank-you page with a download token in the URL fragment.
// IW laeuft mit eigenen Records (optin-iw/), eigenen Token-Zwecken (doi-iw/dl-iw) und eigener Site.
// IW traegt bewusst KEIN Segment ein: das Produkt ist der PDF-Zugang, ein taeglicher Versand ist nicht Teil dieser Einwilligung.
module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const t = url.searchParams.get('t');
  const s = url.searchParams.get('s');
  if (s === 'iw') {
    const id = L.verify('doi-iw', t);
    if (!id) return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt?e=1');
    const rec = await IW.iwStore.get(id);
    if (!rec) return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt?e=1');
    if (!rec.confirmedAt) { rec.confirmedAt = new Date().toISOString(); rec.confirmIp = L.ip(req); rec.unsubscribedAt = null; await IW.iwStore.put(id, rec); }
    const dl = L.token('dl-iw', id, 0);
    return L.redirect(res, IW.SITE_IW + '/tagesbericht-bestaetigt#k=' + dl); // Fragment: geht nicht an Server oder Logs
  }
  const id = L.verify('doi', t);
  const page0 = s === 'tk' ? '/toolkit-bestaetigt' : s === 'atlas' ? '/atlas-daten-bestaetigt' : '/tagesbericht-bestaetigt';
  if (!id) return L.redirect(res, L.SITE + page0 + '?e=1');
  const rec = await L.store.get(id);
  if (!rec) return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?e=1');
  if (!rec.confirmedAt) { rec.confirmedAt = new Date().toISOString(); rec.confirmIp = L.ip(req); rec.unsubscribedAt = null; await L.store.put(id, rec); if (rec.source !== 'atlas') await L.addToSegment(rec.email); } // atlas consent covers the data package only, not the Tagesbericht segment
  const dl = L.token('dl', id, 0);
  const page = s === 'tk' ? '/toolkit-bestaetigt' : s === 'atlas' ? '/atlas-daten-bestaetigt' : '/tagesbericht-bestaetigt';
  L.redirect(res, L.SITE + page + '#k=' + dl); // fragment: not sent to servers or logs
};
