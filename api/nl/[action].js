'use strict';
// Ein Function-Slot fuer die Newsletter-Endpunkte (Vercel-Hobby-Limit: 12 Funktionen).
// Routen aus vercel.json: /lw/api/nlweekly -> /api/nl/weekly, /lw/api/nlunsub -> /api/nl/unsub
const handlers = { weekly: require('../_nlh/weekly'), unsub: require('../_nlh/unsub') };
module.exports = async (req, res) => {
  const h = handlers[req.query && req.query.action];
  if (!h) return res.status(404).end();
  return h(req, res);
};
