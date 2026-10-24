'use strict';
// Ein Function-Slot fuer die kleinen Lead-Wall-Endpunkte (Vercel-Hobby-Limit: 12 Funktionen).
// Routen aus vercel.json Catch-all: /lw/api/:n -> /api/lw/:n (spezifische atlas/iw/fa/nl-Routen stehen davor).
const handlers = {
  pdf: require('../_lwh/pdf'),
  subscribe: require('../_lwh/subscribe'),
  tkdl: require('../_lwh/tkdl'),
  tksub: require('../_lwh/tksub'),
  unsub: require('../_lwh/unsub'),
  upload: require('../_lwh/upload'),
  confirm: require('../_lwh/confirm')
};
module.exports = async (req, res) => {
  const h = handlers[req.query && req.query.action];
  if (!h) return res.status(404).end();
  return h(req, res);
};
