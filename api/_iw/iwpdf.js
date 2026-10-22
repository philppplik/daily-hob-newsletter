'use strict';
const L = require('../_lw');
const IW = require('./iwlib');
// GET ?k=<dl-iw token>&d=YYYY-MM-DD (optional). Prueft den IW-Abonnenten, streamt dann aus privatem Speicher.
module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = L.verify('dl-iw', q.get('k'));
  const rec = id && await IW.iwStore.get(id);
  if (!rec || !rec.confirmedAt || rec.unsubscribedAt) return L.redirect(res, IW.SITE_IW + '/tagesbericht-anmelden');
  const d = q.get('d');
  const hit = /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? { date: d, buf: await IW.fetchIwReport(d) } : await IW.latestIwReport();
  if (!hit || !hit.buf) return L.redirect(res, IW.SITE_IW + '/tagesbericht-anmelden?e=nopdf');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', 'attachment; filename="intelligenz-welt-tagesausgabe-' + hit.date + '.pdf"');
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.end(hit.buf);
};
