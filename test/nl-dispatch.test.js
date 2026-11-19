'use strict';
// Parallel negative tests for the rail-A dispatch state machine (registry CAS map,
// reviewer-converged 24.10.): no atomic create exists, so every runtime write is a
// bounded read-merge-CAS on ONE pre-provisioned registry; sent tombstones are never
// pruned; unknown sends are hard stops; there is no force/resend anywhere.
process.env.LW_STORE = 'memory';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../newsletter/dispatch');

// memory blob with honest CAS semantics (check-and-set is synchronous -> atomic per tick)
function memBlob() {
  const m = new Map(); let seq = 0;
  return {
    async put(k, v) { const etag = 'e' + (++seq); m.set(k, { v: JSON.parse(JSON.stringify(v)), etag }); return { url: 'mem://' + k, pathname: k }; },
    async getWithEtag(url) { const k = String(url).replace('mem://', '').split('?')[0]; const r = m.get(k); return r ? { value: JSON.parse(JSON.stringify(r.v)), etag: r.etag } : null; },
    async putCas(k, v, etag) { if (!etag) throw new Error('blob-etag-missing'); const r = m.get(k); if (!r || r.etag !== etag) return false; const e2 = 'e' + (++seq); m.set(k, { v: JSON.parse(JSON.stringify(v)), etag: e2 }); return true; },
    async del(url) { m.delete(String(url).replace('mem://', '').split('?')[0]); },
    async status(url) { return m.has(String(url).replace('mem://', '').split('?')[0]) ? 200 : 404; },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ url: 'mem://' + k, pathname: k })); }, _map: m
  };
}
// mock resend broadcast API with provider state
function mockResend(opts = {}) {
  const broadcasts = new Map(); let n = 0; const calls = { create: 0, send: 0, list: 0, get: 0 };
  const fn = async (path, body) => {
    if (path === '/broadcasts?limit=100') { calls.list++; return { ok: true, json: { data: [...broadcasts.values()].map((b) => ({ id: b.id, name: b.name, status: b.status })) } }; }
    if (path === '/broadcasts') {
      calls.create++;
      if (opts.createDelay) await new Promise((r) => setTimeout(r, opts.createDelay));
      const id = 'bc_' + (++n); broadcasts.set(id, { id, name: body.name, status: 'draft', sent_at: null });
      return { ok: true, json: { id } };
    }
    const send = path.match(/^\/broadcasts\/(.+)\/send$/);
    if (send) {
      calls.send++;
      const b = broadcasts.get(send[1]);
      if (b) { b.status = 'sent'; b.sent_at = '2026-10-25T07:00:00Z'; }
      if (opts.sendThrowsAfterAccept) { const e = new Error('network reset'); e.ambiguous = true; throw e; }
      return { ok: true, json: { id: send[1] } };
    }
    const get = path.match(/^\/broadcasts\/(.+)$/);
    if (get) { calls.get++; const b = broadcasts.get(get[1]); return b ? { ok: true, json: { ...b } } : { ok: false, status: 404 }; }
    return { ok: false, status: 404 };
  };
  return { fn, calls, broadcasts };
}
const cfg = { key: 'kifb', product: 'KIFB Wochenrückblick', from: 'KI Fachblatt <magazin@kifachblatt.de>' };
const cfgIw = { key: 'iw', product: 'IW Wochenrückblick', from: 'IW <welt@hob.philipp-paulik.de>' };
const model = { subject: 'S', weekLabel: 'KW 43', date: '2026-10-25' };
const REG_KEY = 'nl-registry/registry.json';

// provisioned registry + deps factory (offline provisioning is the only create path)
async function setup() {
  const blob = memBlob();
  const p = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '' });
  assert.equal(p.created, true);
  const deps = (extra = {}) => ({ blob, registryKey: REG_KEY, registryUrl: p.url, segmentIdValue: 'seg1', topicIdValue: 'top1', ...extra });
  return { blob, regUrl: p.url, deps };
}
const issues = async (blob, regUrl) => (await blob.getWithEtag(regUrl)).value.issues;

test('R1: two parallel dispatches of the SAME issue -> exactly one draft, one send; loser stops', async () => {
  const { deps } = await setup(); const rs = mockResend({ createDelay: 20 });
  const [a, b] = await Promise.all([D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn })), D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }))]);
  const oks = [a, b].filter((r) => r.ok);
  assert.equal(oks.length, 1, 'exactly one winner: ' + JSON.stringify([a, b]));
  assert.equal(rs.calls.create, 1, 'exactly one broadcast created');
  assert.equal(rs.calls.send, 1, 'exactly one send call');
  const loser = [a, b].find((r) => !r.ok);
  assert.ok(['locked', 'already-sent'].includes(loser.error), 'loser stopped cleanly: ' + loser.error);
});

test('R2: concurrent claims of DIFFERENT issues merge-preserve (both survive in the registry)', async () => {
  const { blob, regUrl, deps } = await setup(); const rs = mockResend({});
  const [a, b] = await Promise.all([
    D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn })),
    D.dispatch(cfgIw, model, '<html>', deps({ resend: rs.fn }))
  ]);
  assert.equal(a.ok, true, 'kifb dispatched: ' + JSON.stringify(a));
  assert.equal(b.ok, true, 'iw dispatched: ' + JSON.stringify(b));
  const iss = await issues(blob, regUrl);
  assert.equal(iss['kifb-2026-10-25'].state, 'sent', 'kifb issue survived');
  assert.equal(iss['iw-2026-10-25'].state, 'sent', 'iw issue survived the concurrent kifb writes');
});

test('R3: crash after accepted send -> status-only reconcile, never resend; tombstone persists', async () => {
  const { blob, regUrl, deps } = await setup(); const rs = mockResend({ sendThrowsAfterAccept: true });
  const r1 = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }));
  assert.equal(r1.ok, true, 'reconciled via GET status: ' + JSON.stringify(r1));
  assert.equal(r1.reconciled, true);
  assert.equal(rs.calls.send, 1, 'exactly one send attempt');
  const r2 = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }));
  assert.equal(r2.ok, false); assert.equal(r2.error, 'already-sent');
  assert.equal(rs.calls.send, 1, 'still exactly one send');
  const iss = await issues(blob, regUrl);
  assert.equal(iss['kifb-2026-10-25'].state, 'sent', 'sent tombstone is kept, never pruned');
});

test('R4: ambiguous send (provider still draft) -> needs_review hard stop, no resend ever', async () => {
  const { deps } = await setup();
  const rs = mockResend({});
  const origSend = rs.fn; let failOnce = true;
  const flaky = async (path, body) => {
    if (/^\/broadcasts\/.+\/send$/.test(path) && failOnce) {
      failOnce = false; rs.calls.send++;
      const e = new Error('timeout before accept'); throw e; // provider did NOT accept
    }
    return origSend(path, body);
  };
  const d = deps({ resend: flaky });
  const r1 = await D.dispatch(cfg, model, '<html>', d);
  assert.equal(r1.ok, false); assert.equal(r1.error, 'needs_review', JSON.stringify(r1));
  const r2 = await D.dispatch(cfg, model, '<html>', d);
  assert.equal(r2.ok, false);
  assert.ok(['needs_review', 'manual-review-required'].includes(r2.error), 'stays blocked: ' + r2.error);
  assert.equal(rs.calls.send, 1, 'NO automatic resend after ambiguity');
  assert.equal(rs.calls.create, 1);
});

test('R5: crashed pre-send run -> locked (no adoption), operator reset recovers, draft reused', async () => {
  const { blob, regUrl, deps } = await setup();
  const name = cfg.product + ' ' + model.weekLabel;
  // crashed owner left a 'claimed' record AND an orphaned provider draft
  const m = await D.mutateRegistry(deps(), (iss) => { iss['kifb-2026-10-25'] = { claimant: 'crashed-owner', state: 'claimed', name, createdAt: 'x' }; });
  assert.equal(m.ok, true);
  const rs = mockResend({});
  rs.broadcasts.set('bc_orphan', { id: 'bc_orphan', name, status: 'draft' });
  const d = () => deps({ resend: rs.fn });
  const [a, b] = await Promise.all([D.dispatch(cfg, model, '<html>', d()), D.dispatch(cfg, model, '<html>', d())]);
  assert.equal(a.ok, false); assert.equal(b.ok, false);
  assert.equal(a.error, 'locked'); assert.equal(b.error, 'locked');
  assert.equal(rs.calls.send, 0, 'no send while locked');
  assert.equal(rs.calls.create, 0, 'no new broadcast while locked');
  // explicit operator reset (main-routed fresh decision): remove the issue key via CAS
  const reset = await D.mutateRegistry(d(), (iss) => { delete iss['kifb-2026-10-25']; });
  assert.equal(reset.ok, true);
  const r = await D.dispatch(cfg, model, '<html>', d());
  assert.equal(r.ok, true, 'recovery completes after reset: ' + JSON.stringify(r));
  assert.equal(r.broadcastId, 'bc_orphan', 'orphaned draft reused via name match');
  assert.equal(rs.calls.create, 0, 'no duplicate draft after reset');
  assert.equal(rs.calls.send, 1, 'exactly one send total');
});

test('R6: provisionRegistry NEVER overwrites an existing registry (stale-404 overwrite path does not exist)', async () => {
  const blob = memBlob();
  const p1 = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '' });
  assert.equal(p1.created, true);
  // seed an issue, then re-run provisioning: it must inspect only
  await D.mutateRegistry({ blob, registryKey: REG_KEY, registryUrl: p1.url }, (iss) => { iss['kifb-2026-10-25'] = { claimant: 'x', state: 'sent', sentAt: 't' }; });
  const p2 = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: p1.url });
  assert.equal(p2.created, false, 'second provision run must not write');
  // env-lost scenario: no URL known -> LIST absence proof finds the existing registry
  // and inspects it instead of blind-PUT overwriting tombstones
  const p3 = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '' });
  assert.equal(p3.created, false, 'env-lost provision must not blind-PUT over the existing registry');
  assert.equal(p3.url, p1.url, 'existing registry recovered via LIST, not recreated');
  const iss = await issues(blob, p1.url);
  assert.equal(iss['kifb-2026-10-25'].state, 'sent', 'existing registry content untouched');
});

test('R6b: provision fails closed when the absence proof (LIST) errors or is paginated', async () => {
  const blob = memBlob();
  blob.list = async () => { throw new Error('blob-list 500 (fail closed: no absence proof)'); };
  await assert.rejects(() => D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '' }), /fail closed/, 'list error -> no create attempt');
  assert.equal(blob._map.size, 0, 'nothing written without absence proof');
  const blob2 = memBlob();
  blob2.list = async () => { throw new Error('blob-list-paginated (fail closed: no absence proof)'); };
  await assert.rejects(() => D.provisionRegistry({ blob: blob2, registryKey: REG_KEY, registryUrl: '' }), /fail closed/);
  assert.equal(blob2._map.size, 0);
  // configured-but-unreadable URL: ambiguous -> refuse, never blind-PUT
  await assert.rejects(() => D.provisionRegistry({ blob: memBlob(), registryKey: REG_KEY, registryUrl: 'mem://gone' }), /fail closed|unreadable/);
});

test('R7: missing registry is FATAL - no auto-create, no online init', async () => {
  const blob = memBlob(); const rs = mockResend({});
  const r = await D.dispatch(cfg, model, '<html>', { blob, registryKey: REG_KEY, registryUrl: 'mem://nl-registry/registry.json', resend: rs.fn, segmentIdValue: 'seg1', topicIdValue: 'top1' });
  assert.equal(r.ok, false); assert.equal(r.error, 'registry-missing');
  assert.equal(rs.calls.create, 0); assert.equal(rs.calls.send, 0);
  const r2 = await D.dispatch(cfg, model, '<html>', { blob, registryKey: REG_KEY, registryUrl: '', resend: rs.fn, segmentIdValue: 'seg1', topicIdValue: 'top1' });
  assert.equal(r2.error, 'registry-missing', 'no NL_REGISTRY_URL -> fatal too');
});

test('R8: failed-pre is the one take-overable state - exactly one retrier wins', async () => {
  const { blob, regUrl, deps } = await setup();
  await D.mutateRegistry(deps(), (iss) => { iss['kifb-2026-10-25'] = { claimant: 'dead', state: 'failed-pre', reason: 'draft-create: x' }; });
  const rs = mockResend({});
  const [a, b] = await Promise.all([D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn })), D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }))]);
  const oks = [a, b].filter((r) => r.ok);
  assert.equal(oks.length, 1, 'exactly one retrier took over: ' + JSON.stringify([a, b]));
  assert.equal(rs.calls.send, 1);
  const iss = await issues(blob, regUrl);
  assert.equal(iss['kifb-2026-10-25'].state, 'sent');
});

test('R9: probeStorage passes against a CAS-honest store (disposable registry, P1-P8)', async () => {
  const blob = memBlob();
  const r = await D.probeStorage({ blob });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal([...blob._map.keys()].filter((k) => k.startsWith('nl-probe/')).length, 0, 'probe keys cleaned up');
});

test('R10: duplicate drafts detected -> needs_review, nothing sent', async () => {
  const { deps } = await setup(); const rs = mockResend({});
  const name = cfg.product + ' ' + model.weekLabel;
  rs.broadcasts.set('bc_a', { id: 'bc_a', name, status: 'draft' });
  rs.broadcasts.set('bc_b', { id: 'bc_b', name, status: 'draft' });
  const r = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }));
  assert.equal(r.ok, false); assert.equal(r.error, 'needs_review'); assert.equal(r.reason, 'duplicate-drafts');
  assert.equal(rs.calls.send, 0, 'nothing sent');
});

test('R11: topicId is mandatory - no broadcast can ever target a bare segment', async () => {
  const { deps } = await setup(); const rs = mockResend({});
  const r = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn, topicIdValue: undefined }));
  assert.equal(r.ok, false); assert.equal(r.error, 'audience-unresolved');
  assert.equal(rs.calls.create, 0, 'no broadcast created without topic');
  const r2 = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn, segmentIdValue: undefined }));
  assert.equal(r2.error, 'audience-unresolved');
  assert.equal(rs.calls.create, 0);
});

test('R12: broadcast create body carries topic_id + segment_id + unsubscribe placeholder html', async () => {
  const { deps } = await setup(); const rs = mockResend({});
  let seen = null; const orig = rs.fn;
  const spy = async (path, body) => { if (path === '/broadcasts') seen = body; return orig(path, body); };
  const r = await D.dispatch(cfg, model, 'HTML with {{{RESEND_UNSUBSCRIBE_URL}}}', deps({ resend: spy }));
  assert.equal(r.ok, true);
  assert.equal(seen.topic_id, 'top1'); assert.equal(seen.segment_id, 'seg1');
  assert.ok(seen.html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'), 'provider unsubscribe placeholder in broadcast html');
});

test('R13: unresolved audience-sync failure BLOCKS the dispatch (needs_review), nothing sent', async () => {
  const { blob, regUrl, deps } = await setup(); const rs = mockResend({});
  const syncAudience = async () => ({ ok: false, synced: 2, failed: ['h1'], at: 't' });
  const r = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn, syncAudience }));
  assert.equal(r.ok, false); assert.equal(r.error, 'needs_review'); assert.equal(r.reason, 'audience-sync-unresolved');
  assert.equal(rs.calls.send, 0, 'held before commit: no send with unresolved sync');
  const iss = await issues(blob, regUrl);
  assert.equal(iss['kifb-2026-10-25'].state, 'needs_review');
  assert.deepEqual(iss['kifb-2026-10-25'].audienceSync.failed, ['h1']);
});

test('R14: provider opt-out after applied consent is never undone - applied records are not re-synced', async () => {
  const { deps } = await setup(); const rs = mockResend({});
  const optedIn = [];
  const recipients = [
    { email: 'applied@test.de', id: 'a', syncApplied: true },   // consent applied; user opted out on the provider page since
    { email: 'fresh@test.de', id: 'f', syncApplied: false }     // fresh consent, not yet applied
  ];
  const syncAudience = async () => {
    for (const r of recipients) { if (r.syncApplied) continue; optedIn.push(r.email); }
    return { ok: true, synced: optedIn.length, skippedApplied: 1, failed: [], at: 't' };
  };
  const r = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn, syncAudience }));
  assert.equal(r.ok, true);
  assert.deepEqual(optedIn, ['fresh@test.de'], 'only the fresh, unapplied consent is opted in - the provider opt-out stands');
});

test('broadcast inventory: strict pagination + strict schema validation, fail closed', async () => {
  const D = require('../newsletter/dispatch');
  const mk = (handler) => { const calls = []; return { calls, fn: async (u) => { calls.push(u); return handler(calls.length - 1, u); } }; };
  const page = (data, hasMore) => ({ ok: true, json: { has_more: hasMore, data } });
  const rec = (id, extra) => ({ id, name: 'N', status: 'sent', created_at: 'c', scheduled_at: null, sent_at: null, ...(extra || {}) });

  // happy path: two pages with after cursor, explicit completion
  let m = mk((i) => i === 0 ? page([rec('b1')], true) : page([rec('b2')], false));
  let inv = await D.listBroadcastInventory({ resend: m.fn });
  assert.equal(inv.complete, true);
  assert.equal(inv.pages, 2);
  assert.equal(inv.broadcasts.length, 2);
  assert.ok(m.calls[1].includes('after=b1'), 'cursor passed');
  assert.ok(m.calls.every((u) => u.startsWith('/broadcasts?')), 'GET list paths only');

  const bad = [
    ['json null', () => ({ ok: true, json: null }), /schema/],
    ['empty object', () => ({ ok: true, json: {} }), /schema/],
    ['has_more as string', () => ({ ok: true, json: { has_more: 'yes', data: [] } }), /schema/],
    ['data not array', () => ({ ok: true, json: { has_more: false, data: {} } }), /schema/],
    ['record without id', () => page([{}], false), /record-schema/],
    ['record empty id', () => page([{ id: '' }], false), /record-schema/],
    ['record bad name type', () => page([rec('b1', { name: 5 })], false), /record-schema/],
    ['record bad status type', () => page([rec('b1', { status: null })], false), /record-schema/],
    ['record bad created_at type', () => page([rec('b1', { created_at: 7 })], false), /record-schema/],
    ['empty page while has_more', () => page([], true), /page-empty/],
    ['repeated cursor', () => page([rec('b1')], true), /cursor-repeat|duplicate-id/],
    ['duplicate id across pages', (i) => page([rec('b1')], i === 0), /duplicate-id|cursor-repeat/],
    ['non-ok status', () => ({ ok: false, status: 500, json: null }), /broadcast-list 500/],
    ['transport error', () => { throw new Error('socket'); }, /broadcast-list transport/]
  ];
  for (const [name, handler, re] of bad) {
    m = mk(handler);
    await assert.rejects(() => D.listBroadcastInventory({ resend: m.fn }), re, name);
  }

  // error AFTER a valid first page: whole result discarded
  m = mk((i) => i === 0 ? page([rec('b1')], true) : ({ ok: true, json: {} }));
  await assert.rejects(() => D.listBroadcastInventory({ resend: m.fn }), /schema/, 'second bad page discards result');

  // 10-page limit with ever-new ids
  m = mk((i) => page([rec('b' + i)], true));
  await assert.rejects(() => D.listBroadcastInventory({ resend: m.fn }), /pages-exceeded/);
  assert.equal(m.calls.length, 10, 'bounded to 10 pages');
});
