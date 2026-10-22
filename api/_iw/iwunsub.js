'use strict';
const L = require('../_lw');
const IW = require('./iwlib');
// GET ?t=<unsub-iw token>: One-Click-Abmeldung ohne Login, danach Redirect auf die IW-Abmeldeseite.
module.exports = async (req, res) => {
  const t = new URL(req.url, 'http://x').searchParams.get('t');
  const id = L.verify('unsub-iw', t);
  if (id) { const rec = await IW.iwStore.get(id); if (rec && !rec.unsubscribedAt) { rec.unsubscribedAt = new Date().toISOString(); await IW.iwStore.put(id, rec); } }
  if (req.method === 'POST') return L.json(res, 200, { ok: !!id });
  L.redirect(res, IW.SITE_IW + '/abmelden?ok=' + (id ? 1 : 0));
};
