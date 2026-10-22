'use strict';
// Ein Function-Slot fuer alle Atlas-Endpunkte (Vercel-Hobby-Limit: 12 Funktionen).
// Routen kommen aus vercel.json: /lw/api/atlassub -> /api/lw-atlas/sub,
// /lw/api/atlasdl -> /api/lw-atlas/dl, /lw/api/atlasupload -> /api/lw-atlas/upload
const handlers = { sub: require('../_atlas/atlassub'), dl: require('../_atlas/atlasdl'), upload: require('../_atlas/atlasupload') };
module.exports = async (req, res) => {
  const h = handlers[req.query && req.query.action];
  if (!h) return res.status(404).end();
  return h(req, res);
};
