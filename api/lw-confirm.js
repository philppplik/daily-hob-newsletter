'use strict';
const L = require('./_lw');
// GET ?t=<doi token> -> mark confirmed, redirect to the thank-you page with a download token in the URL fragment.
module.exports = async (req, res) => {
  const t = new URL(req.url, 'http://x').searchParams.get('t');
  const id = L.verify('doi', t);
  const s0 = new URL(req.url, 'http://x').searchParams.get('s');
  const page0 = s0 === 'tk' ? '/toolkit-bestaetigt' : s0 === 'atlas' ? '/atlas-daten-bestaetigt' : '/tagesbericht-bestaetigt';
  if (!id) return L.redirect(res, L.SITE + page0 + '?e=1');
  const rec = await L.store.get(id);
  if (!rec) return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?e=1');
  if (!rec.confirmedAt) { rec.confirmedAt = new Date().toISOString(); rec.confirmIp = L.ip(req); rec.unsubscribedAt = null; await L.store.put(id, rec); if (rec.source !== 'atlas') await L.addToSegment(rec.email); } // atlas consent covers the data package only, not the Tagesbericht segment
  const dl = L.token('dl', id, 0);
  const sp = new URL(req.url, 'http://x').searchParams.get('s');
  const page = sp === 'tk' ? '/toolkit-bestaetigt' : sp === 'atlas' ? '/atlas-daten-bestaetigt' : '/tagesbericht-bestaetigt';
  L.redirect(res, L.SITE + page + '#k=' + dl); // fragment: not sent to servers or logs
};
