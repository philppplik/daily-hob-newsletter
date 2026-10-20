'use strict';
const L = require('./_lw');
// GET ?t=<doi token> -> mark confirmed, redirect to the thank-you page with a download token in the URL fragment.
module.exports = async (req, res) => {
  const t = new URL(req.url, 'http://x').searchParams.get('t');
  const id = L.verify('doi', t);
  if (!id) return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?e=1');
  const rec = await L.store.get(id);
  if (!rec) return L.redirect(res, L.SITE + '/tagesbericht-bestaetigt?e=1');
  if (!rec.confirmedAt) { rec.confirmedAt = new Date().toISOString(); rec.confirmIp = L.ip(req); rec.unsubscribedAt = null; await L.store.put(id, rec); await L.addToSegment(rec.email); }
  const dl = L.token('dl', id, 0);
  L.redirect(res, L.SITE + '/tagesbericht-bestaetigt#k=' + dl); // fragment: not sent to servers or logs
};
