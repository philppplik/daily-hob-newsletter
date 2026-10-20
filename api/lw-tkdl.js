'use strict';
const L = require('./_lw');
// GET ?k=<download token>. Checks the subscriber, then streams the toolkit ZIP from private storage.
module.exports = async (req, res) => {
  const k = new URL(req.url, 'http://x').searchParams.get('k');
  const id = L.verify('dl', k);
  const rec = id && await L.store.get(id);
  if (!rec || !rec.confirmedAt || rec.unsubscribedAt) return L.redirect(res, L.SITE + '/toolkit');
  const buf = await L.fetchToolkit(L.TK_VERSION);
  if (!buf) return L.redirect(res, L.SITE + '/toolkit?e=nofile');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', 'attachment; filename="kifb-eu-ki-toolkit-v' + L.TK_VERSION + '.zip"');
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.end(buf);
};
