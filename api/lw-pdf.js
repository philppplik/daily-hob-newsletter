'use strict';
const L = require('./_lw');
// GET ?k=<download token>&d=YYYY-MM-DD (optional). Checks the subscriber, then streams the PDF from private storage.
module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = L.verify('dl', q.get('k'));
  const rec = id && await L.store.get(id);
  if (!rec || !rec.confirmedAt || rec.unsubscribedAt) return L.redirect(res, L.SITE + '/tagesbericht-anmelden');
  const d = q.get('d');
  const hit = /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? { date: d, buf: await L.fetchReport(d) } : await L.latestReport();
  if (!hit || !hit.buf) return L.redirect(res, L.SITE + '/tagesbericht-anmelden?e=nopdf');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', 'attachment; filename="ki-tagesbericht-' + hit.date + '.pdf"');
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.end(hit.buf);
};
