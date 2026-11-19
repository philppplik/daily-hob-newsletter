'use strict';
// One-click unsubscribe for a site's Wochenrückblick only (per-purpose, per-site).
// The Tagesbericht / PDF consent stays untouched. List-Unsubscribe-Post lands here too.
const L = require('../_lw');
const { SITES } = require('../../newsletter/config');

const STORES = {
  kifb: () => L.store,
  iw: () => require('../_iw/iwlib').iwStore,
  fa: () => require('../_fa/falib').faStore
};

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const cfg = SITES[String(q.get('site') || '').toLowerCase()];
  if (!cfg) return L.json(res, 400, { ok: false });
  const id = L.verify('nl-' + cfg.key, q.get('t'));
  let unresolved = false;
  if (id) {
    const store = STORES[cfg.key]();
    const rec = await store.get(id);
    const cur = rec && rec.nlUnsub && rec.nlUnsub[cfg.key];
    if (rec && !(cur && (cur.provider === 'ok' || cur.provider === 'n/a'))) {
      // durable pending marker FIRST: the blob record is our consent truth, the
      // provider mirror must never silently fail (a silent failure would keep the
      // recipient in the provider topic while our blob says unsubscribed).
      await store.mutateCas(id, (r) => {
        r.nlUnsub = Object.assign({}, r.nlUnsub, { [cfg.key]: { at: (cur && cur.at) || new Date().toISOString(), provider: 'pending' } });
      });
      // opt-out retry is idempotent-safe; the provider result is verified, not assumed
      const out = await require('../../newsletter/audience-sync').applyOptOut(L, rec, cfg.key);
      // 'unconfigured' (no topic yet, pre-approval) means no provider mirror exists -
      // the blob record is then the complete and honest opt-out state.
      const prov = out.status === 'ok' ? 'ok' : (out.status === 'unconfigured' || out.status === 'not-present') ? 'n/a' : 'failed';
      await store.mutateCas(id, (r) => {
        const c = r.nlUnsub && r.nlUnsub[cfg.key];
        r.nlUnsub = Object.assign({}, r.nlUnsub, { [cfg.key]: { at: (c && c.at) || new Date().toISOString(), provider: prov, error: out.error } });
      });
      unresolved = prov === 'failed';
    }
  }
  if (req.method === 'POST') return L.json(res, unresolved ? 503 : 200, unresolved ? { ok: false, error: 'optout-unresolved' } : { ok: !!id });
  // never a false-success redirect: unresolved provider opt-out lands on an error target
  if (unresolved) return L.redirect(res, cfg.site + cfg.unsubPage.split('?')[0] + '?e=1');
  L.redirect(res, cfg.site + cfg.unsubPage);
};
