'use strict';
// Weekly Sunday newsletter per site. Auth: HMAC x-lw-auth = sign('nl:<site>:<date>'),
// same LW_SECRET pattern as the report uploads - no new secrets, no new env vars.
// GET  ?site=&date=&dry=1&format=json|html  -> summary or rendered preview (admin only)
// POST ?site=&date=[&to=test@adress.de]     -> real send (per-recipient, one-click unsub)
// ?to= replaces the whole recipient list (template review before first send).
const crypto = require('crypto');
const L = require('../_lw');
const { SITES } = require('../../newsletter/config');
const content = require('../../newsletter/content');
const core = require('../../newsletter/core');
const dispatch = require('../../newsletter/dispatch');
const { render } = require('../../newsletter/template');

const STORES = {
  kifb: () => L.store,
  iw: () => require('../_iw/iwlib').iwStore,
  fa: () => require('../_fa/falib').faStore
};
const logStore = L.storeFor('nl-log/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const cfg = SITES[String(q.get('site') || '').toLowerCase()];
  if (!cfg) return L.json(res, 400, { ok: false, error: 'site' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const got = Buffer.from(String(req.headers['x-lw-auth'] || ''));
  const want = Buffer.from(L.sign('nl:' + cfg.key + ':' + date));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return L.json(res, 401, { ok: false });

  const to = L.norm(q.get('to') || '');
  // No force parameter anywhere (review v2): 'already-sent' and 'needs_review' are
  // terminal; resets are explicit operator decisions routed via main.
  const logKey = cfg.key + '-' + date + (to ? '-test-' + L.idOf(to) : '');
  const old = to ? await logStore.get(logKey) : null;
  if (old && old.sentAt && req.method === 'POST') return L.json(res, 200, { ok: false, error: 'already-sent', log: old });

  // Curated editorial selection (freigegebener Wochenversand): a reviewed
  // nl-curated/<site>-<date>.json at a stable blob URL selects/orders/re-images ONLY
  // this week's feed URLs - it can never inject foreign links, secrets or recipients.
  const { applyCurated } = require('../../newsletter/curated');
  const curatedUrl = process.env['NL_CURATED_URL_' + cfg.key.toUpperCase()] || '';
  let curatedState = curatedUrl ? 'missing' : 'off';
  let curatedSkipped = [];
  let week = await content.fetchWeek(cfg, date);
  if (curatedUrl) {
    try {
      const cr = await fetch(curatedUrl + (curatedUrl.includes('?') ? '&' : '?') + 'cache=0', { cache: 'no-store' });
      if (cr.ok) {
        week = applyCurated(week, await cr.json(), cfg);
        curatedState = 'applied';
        curatedSkipped = week.curatedSkipped;
      }
    } catch (e) { curatedState = 'unreadable'; }
  }
  // Fail closed: with NL_REQUIRE_CURATED=1 no broadcast leaves without the reviewed selection.
  if (req.method === 'POST' && q.get('dry') !== '1' && !to && process.env.NL_REQUIRE_CURATED === '1' && curatedState !== 'applied') {
    return L.json(res, 409, { ok: false, error: 'needs-curation', site: cfg.key, date, curated: curatedState });
  }
  if (week.items.length < 3) return L.json(res, 200, { ok: false, error: 'thin-content', items: week.items.length });
  if (req.method === 'POST' && q.get('dry') !== '1' && !cfg.from) return L.json(res, 503, { ok: false, error: 'sender-unresolved', site: cfg.key });
  const subject = content.subjectFor(cfg, week.items, week.total, week.more.length);
  const model = { subject, preheader: 'Die Woche vom ' + week.weekLabel.split('· ')[1] + ': ' + week.total + ' Artikel aus ' + cfg.name + '.', weekLabel: week.weekLabel, items: week.items, more: week.more };
  const cfgExtra = { ...cfg, extra: week.extra };

  if (q.get('probe') === '1') {
    // scoped live storage probe: DISPOSABLE nl-probe/ registry + keys only (never the
    // production registry, never mail), cleaned up afterwards
    const pr = await dispatch.probeStorage({});
    return L.json(res, pr.ok ? 200 : 503, { ok: pr.ok, probe: pr });
  }
  if (req.method !== 'POST' || q.get('dry') === '1') {
    if (q.get('format') === 'html') {
      const { render } = require('../../newsletter/template');
      const { html } = render({ cfg: cfgExtra, subject, preheader: model.preheader, weekLabel: week.weekLabel, items: week.items, more: week.more, unsubUrl: cfg.site + cfg.unsubPage });
      res.statusCode = 200; res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
      return res.end(html);
    }
    let recordCount = null, eligibleCount = null, masked = [];
    if (!to) {
      const el = await core.eligible(cfg, { store: STORES[cfg.key]() });
      recordCount = el.recordCount; eligibleCount = el.recipients.length;
      masked = el.recipients.slice(0, 10).map((r) => r.email.replace(/^(.).*(@.*)$/, '$1***$2'));
    }
    return L.json(res, 200, { ok: true, dry: true, site: cfg.key, date, subject, sender: cfg.from, window: week.weekLabel, items: week.items.length, more: week.more.length, feedTotal: week.total, curated: curatedState, curatedSkipped, recordCount, eligible: to ? 1 : eligibleCount, masked, alreadySent: !!(old && old.sentAt) });
  }

  if (to) {
    // template-review path: one explicit address, transactional, unchanged
    const results = await core.sendAll(cfgExtra, model, [{ email: to, id: L.idOf(to) }], {});
    const log = { site: cfg.key, date, test: true, subject, sentAt: new Date().toISOString(), sent: results.sent, failed: results.failed, recipients: 1 };
    await logStore.put(logKey, log);
    return L.json(res, 200, { ok: results.failed.length === 0, ...log });
  }
  // bulk path: rail-A broadcast dispatch (draft-first + atomic ownership).
  // Fail-closed: requires NL_DISPATCH_ENABLED=1 AND NL_CAS_VERIFIED=1 (live probe),
  // plus the audience ids (segment + topic, both mandatory) - PENDING user approval.
  if (!dispatch.dispatchEnabled()) return L.json(res, 503, { ok: false, error: 'dispatch-disabled', note: 'awaiting live probe (NL_CAS_VERIFIED) and operator enable (NL_DISPATCH_ENABLED)' });
  if (!process.env.NL_REGISTRY_URL) return L.json(res, 503, { ok: false, error: 'registry-missing', note: 'offline provisioning required (scripts/nl-registry-provision.js); no auto-create' });
  if (!cfg.segmentId || !cfg.topicId) return L.json(res, 503, { ok: false, error: 'audience-unresolved', site: cfg.key, note: 'segmentId AND topicId are both required (pending user approval)' });

  // Unresolved provider opt-outs block the whole site broadcast: our blob may say
  // unsubscribed while the provider topic still includes the recipient. Retry the
  // (idempotent) opt-out, verify the result, and refuse to send while any remains.
  {
    const store = STORES[cfg.key]();
    const all = await store.list();
    const sync = require('../../newsletter/audience-sync');
    const unresolvedOut = [];
    for (const { id, rec } of all) {
      const u = rec && rec.nlUnsub && rec.nlUnsub[cfg.key];
      if (!u || u.provider === 'ok' || u.provider === 'n/a') continue;
      const out = await sync.applyOptOut(L, rec, cfg.key);
      await store.mutateCas(id, (r) => {
        r.nlUnsub = Object.assign({}, r.nlUnsub, { [cfg.key]: { at: u.at, provider: out.status === 'ok' ? 'ok' : 'failed', error: out.error } });
      }).catch(() => {});
      if (out.status !== 'ok') unresolvedOut.push(id);
    }
    if (unresolvedOut.length) return L.json(res, 409, { ok: false, error: 'optout-unresolved', blocked: unresolvedOut.sort(), note: 'broadcast held: provider opt-out could not be verified; resolve before any send' });
  }

  const el = await core.eligible(cfg, { store: STORES[cfg.key]() });
  // Broadcast unsubscribe: provider placeholder (topic-scoped preference page). Our
  // per-recipient /nlunsub link cannot be personalized inside a broadcast, so the
  // footer Abmelden link is the provider URL here; nl-unsub stays the transactional path.
  const { html } = render({ cfg: cfgExtra, subject, preheader: model.preheader, weekLabel: week.weekLabel, items: week.items, more: week.more, unsubUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}' });
  // durable audience+consent snapshot: exact hashed eligible ids, never plain emails (M4)
  const snapshot = { recordCount: el.recordCount, recipients: el.recipients.length, ids: el.recipients.map((r) => L.idOf(r.email)).sort(), at: new Date().toISOString() };
  // Apply-once provider audience sync via newsletter/audience-sync.js: durable marker
  // BEFORE any external call, topic opt-in last, unknown never blind-retried.
  // Already-applied records are skipped (provider preferences win). Anything not
  // provably applied (failed-pre, unknown, needs-review, unconfigured) is returned as
  // blocked with hashed IDs and FAILS the dispatch (dispatch.js -> needs_review, no send).
  const sync = require('../../newsletter/audience-sync');
  const syncAudience = async () => {
    const store = STORES[cfg.key]();
    let synced = 0, skippedApplied = 0; const blocked = [];
    for (const r of el.recipients) {
      if (r.syncApplied) { skippedApplied++; continue; }
      const rec = await store.get(r.id);
      if (!rec) { blocked.push(r.id); continue; }
      const out = await sync.applyConsent({ L, store, site: cfg.key }, rec).catch(() => ({ status: 'unknown' }));
      if (out.status === 'applied' || out.status === 'reconciled-applied') synced++;
      else blocked.push(r.id + ':' + out.status);
    }
    return { ok: blocked.length === 0, synced, skippedApplied, failed: blocked, at: new Date().toISOString() };
  };
  let result;
  try {
    result = await dispatch.dispatch(cfg, { ...model, date }, html, {
    segmentIdValue: cfg.segmentId,
    topicIdValue: cfg.topicId,
      eligibleSnapshot: snapshot,
      syncAudience
    });
  } catch (e) {
    // fail closed: a dispatch-layer exception must never surface as a crash or a send
    return L.json(res, 503, { ok: false, error: 'dispatch-error', note: String(e && e.message || e) });
  }
  L.json(res, result.ok ? 200 : 409, { site: cfg.key, date, subject, ...result });
};
