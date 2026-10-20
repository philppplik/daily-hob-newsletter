'use strict';
const L = require('./_lw');
// GET ?t=<unsub token> shows nothing, just unsubscribes (one click, no login) and redirects. List-Unsubscribe-Post also lands here.
module.exports = async (req, res) => {
  const t = new URL(req.url, 'http://x').searchParams.get('t');
  const id = L.verify('unsub', t);
  if (id) { const rec = await L.store.get(id); if (rec && !rec.unsubscribedAt) { rec.unsubscribedAt = new Date().toISOString(); await L.store.put(id, rec); } }
  if (req.method === 'POST') return L.json(res, 200, { ok: !!id });
  L.redirect(res, L.SITE + '/abmelden?ok=' + (id ? 1 : 0));
};
