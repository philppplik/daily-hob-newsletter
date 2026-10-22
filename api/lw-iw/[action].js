'use strict';
// Ein Function-Slot fuer alle IW-Leadwall-Endpunkte (Vercel-Hobby-Limit: 12 Funktionen).
// Routen aus vercel.json: /lw/api/iwsub -> /api/lw-iw/sub, /lw/api/iwpdf -> /api/lw-iw/pdf,
// /lw/api/iwupload -> /api/lw-iw/upload, /lw/api/iwunsub -> /api/lw-iw/unsub
const handlers = { sub: require('../_iw/iwsub'), pdf: require('../_iw/iwpdf'), upload: require('../_iw/iwupload'), unsub: require('../_iw/iwunsub') };
module.exports = async (req, res) => {
  const h = handlers[req.query && req.query.action];
  if (!h) return res.status(404).end();
  return h(req, res);
};
