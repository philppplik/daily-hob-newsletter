'use strict';
const L = require('./_lw');
// GET ?k=<download token>. Checks the subscriber, then streams the atlas data ZIP from private storage.
module.exports = async (req, res) => {
  const k = new URL(req.url, 'http://x').searchParams.get('k');
  const id = L.verify('dl', k);
  const rec = id && await L.store.get(id);
  if (!rec || !rec.confirmedAt || rec.unsubscribedAt) return L.redirect(res, L.SITE + '/atlas-daten-anmelden');
  const buf = await L.fetchAtlas(L.ATLAS_VERSION);
  if (!buf) return L.redirect(res, L.SITE + '/atlas-daten-anmelden?e=nofile');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', 'attachment; filename="modell-atlas-datenpaket-v' + L.ATLAS_VERSION + '.zip"');
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.end(buf);
};
