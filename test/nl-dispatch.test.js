'use strict';
// Parallel negative tests for the rail-A dispatch state machine (registry CAS map,
// reviewer-converged 24.10.): no atomic create exists, so every runtime write is a
// bounded read-merge-CAS on ONE pre-provisioned registry; sent tombstones are never
// pruned; unknown sends are hard stops; there is no force/resend anywhere.
process.env.LW_STORE = 'memory';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../newsletter/dispatch');
const crypto = require('crypto');

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
    if (path === '/broadcasts?limit=100') { calls.list++; return { ok: true, json: { has_more: false, data: [...broadcasts.values()].map((b) => ({ id: b.id, name: b.name, status: b.status })) } }; }
    if (path === '/broadcasts') {
      calls.create++;
      if (opts.createDelay) await new Promise((r) => setTimeout(r, opts.createDelay));
      const id = 'bc_' + (++n); broadcasts.set(id, { id, name: body.name, status: 'draft', sent_at: null, segment_id: body.segment_id, topic_id: body.topic_id, from: body.from, subject: body.subject, html: body.html, reply_to: body.reply_to || null });
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
  const p = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '', seedMeta: { minIssueWeek: '2020-W01' } });
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
  assert.equal(iss['kifb-2026-W43'].state, 'sent', 'kifb issue survived');
  assert.equal(iss['iw-2026-W43'].state, 'sent', 'iw issue survived the concurrent kifb writes');
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
  assert.equal(iss['kifb-2026-W43'].state, 'sent', 'sent tombstone is kept, never pruned');
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
  const m = await D.mutateRegistry(deps(), (iss) => { iss['kifb-2026-W43'] = { claimant: 'crashed-owner', state: 'claimed', name, createdAt: '2026-10-25T06:00:00Z' }; });
  assert.equal(m.ok, true);
  const rs = mockResend({});
  rs.broadcasts.set('bc_orphan', { id: 'bc_orphan', name, status: 'draft', segment_id: 'seg1', topic_id: 'top1', from: cfg.from });
  const d = () => deps({ resend: rs.fn });
  const [a, b] = await Promise.all([D.dispatch(cfg, model, '<html>', d()), D.dispatch(cfg, model, '<html>', d())]);
  assert.equal(a.ok, false); assert.equal(b.ok, false);
  assert.equal(a.error, 'locked'); assert.equal(b.error, 'locked');
  assert.equal(rs.calls.send, 0, 'no send while locked');
  assert.equal(rs.calls.create, 0, 'no new broadcast while locked');
  // explicit operator reset (main-routed fresh decision): remove the issue key via CAS
  const reset = await D.mutateRegistry(d(), (iss) => { delete iss['kifb-2026-W43']; });
  assert.equal(reset.ok, true);
  // after the reset the orphaned draft is UNBOUND (claim carried no broadcastId):
  // it is never adopted - hard needs_review, zero sends, zero new drafts
  let r = await D.dispatch(cfg, model, '<html>', d());
  assert.equal(r.error, 'needs_review');
  assert.equal(r.reason, 'draft-exists-unowned');
  assert.equal(rs.calls.send, 0); assert.equal(rs.calls.create, 0);
  // only after the operator clears BOTH the issue record AND the foreign draft does a fresh claim create+send
  await D.mutateRegistry(deps(), (iss) => { delete iss['kifb-2026-W43']; });
  rs.broadcasts.delete('bc_orphan');
  r = await D.dispatch(cfg, model, '<html>', d());
  assert.equal(r.ok, true, 'recovery completes after foreign draft is cleared: ' + JSON.stringify(r));
  assert.equal(rs.calls.send, 1, 'exactly one send total');
});

test('R6: provisionRegistry NEVER overwrites an existing registry (stale-404 overwrite path does not exist)', async () => {
  const blob = memBlob();
  const p1 = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '', seedMeta: { minIssueWeek: '2020-W01' } });
  assert.equal(p1.created, true);
  // seed an issue, then re-run provisioning: it must inspect only
  await D.mutateRegistry({ blob, registryKey: REG_KEY, registryUrl: p1.url }, (iss) => { iss['kifb-2026-W43'] = { state: 'sent', broadcastId: 'bc1', sentAt: '2026-10-25T07:00:00Z' }; });
  const p2 = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: p1.url });
  assert.equal(p2.created, false, 'second provision run must not write');
  // env-lost scenario: no URL known -> LIST absence proof finds the existing registry
  // and inspects it instead of blind-PUT overwriting tombstones
  const p3 = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '' });
  assert.equal(p3.created, false, 'env-lost provision must not blind-PUT over the existing registry');
  assert.equal(p3.url, p1.url, 'existing registry recovered via LIST, not recreated');
  const iss = await issues(blob, p1.url);
  assert.equal(iss['kifb-2026-W43'].state, 'sent', 'existing registry content untouched');
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
  await D.mutateRegistry(deps(), (iss) => { iss['kifb-2026-W43'] = { claimant: 'dead', state: 'failed-pre', reason: 'draft-create: x', name: cfg.product + ' ' + model.weekLabel, createdAt: '2026-10-25T06:00:00Z' }; });
  const rs = mockResend({});
  const [a, b] = await Promise.all([D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn })), D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }))]);
  const oks = [a, b].filter((r) => r.ok);
  assert.equal(oks.length, 1, 'exactly one retrier took over: ' + JSON.stringify([a, b]));
  assert.equal(rs.calls.send, 1);
  const iss = await issues(blob, regUrl);
  assert.equal(iss['kifb-2026-W43'].state, 'sent');
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
  assert.equal(r.ok, false); assert.equal(r.error, 'needs_review'); assert.equal(r.reason, 'draft-exists-unowned');
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
  assert.equal(iss['kifb-2026-W43'].state, 'needs_review');
  assert.deepEqual(iss['kifb-2026-W43'].audienceSync.failed, ['h1']);
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

test('B1: seeded provisioning validates schema strictly, writes issues+meta at creation only', async () => {
  const blob = memBlob();
  const seed = { 'kifb-2026-W47': { state: 'blocked-legacy', reason: 'recovery-cutoff' }, 'iw-2026-W43': { state: 'sent', broadcastId: 'bcX', sentAt: '2026-10-25T07:00:00Z' }, 'fa-2026-W47': { state: 'sent', broadcastId: 'bcY', sentAt: '2026-11-19T00:30:00+01:00' } };
  const p = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '', seedIssues: seed, seedMeta: { minIssueWeek: '2026-W48' } });
  assert.equal(p.created, true);
  const back = (await blob.getWithEtag(p.url)).value;
  assert.deepEqual(back.issues, seed, 'seed persisted verbatim');
  assert.equal(back.meta.minIssueWeek, '2026-W48');
  const rej = [
    ['seed not object', { seedIssues: [], seedMeta: { minIssueWeek: '2026-W48' } }],
    ['missing meta', { seedIssues: seed }],
    ['bad meta week', { seedIssues: seed, seedMeta: { minIssueWeek: '2026-11-19' } }],
    ['meta week 54', { seedIssues: seed, seedMeta: { minIssueWeek: '2026-W54' } }],
    ['unknown meta key', { seedIssues: seed, seedMeta: { minIssueWeek: '2026-W48', x: 1 } }],
    ['bad issue key', { seedIssues: { 'kifb-2026-11-19': { state: 'blocked-legacy', reason: 'x' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['issue week 99', { seedIssues: { 'kifb-2026-W99': { state: 'blocked-legacy', reason: 'x' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['nonexistent ISO week 2025-W53 (meta)', { seedIssues: seed, seedMeta: { minIssueWeek: '2025-W53' } }],
    ['nonexistent ISO week 2025-W53 (key)', { seedIssues: { 'kifb-2025-W53': { state: 'blocked-legacy', reason: 'x' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['unknown site', { seedIssues: { 'xx-2026-W47': { state: 'blocked-legacy', reason: 'x' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['seed false', { seedIssues: false, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['seed null', { seedIssues: null, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['state array', { seedIssues: { 'kifb-2026-W47': [] }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['sentAt normalised 2026-02-30', { seedIssues: { 'kifb-2026-W47': { state: 'sent', broadcastId: 'b', sentAt: '2026-02-30T10:00:00Z' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['bad state', { seedIssues: { 'kifb-2026-W47': { state: 'nonsense' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['sent without broadcastId', { seedIssues: { 'kifb-2026-W47': { state: 'sent', sentAt: '2026-10-25T07:00:00Z' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['sent bad sentAt', { seedIssues: { 'kifb-2026-W47': { state: 'sent', broadcastId: 'b', sentAt: 'not-a-date' } }, seedMeta: { minIssueWeek: '2026-W48' } }],
    ['blocked-legacy without reason', { seedIssues: { 'kifb-2026-W47': { state: 'blocked-legacy' } }, seedMeta: { minIssueWeek: '2026-W48' } }]
  ];
  for (const [name, deps] of rej) {
    await assert.rejects(() => D.provisionRegistry({ blob: memBlob(), registryKey: REG_KEY, registryUrl: '', ...deps }), /seed-invalid/, name);
  }
});

test('B2: fail-closed meta gate, canonical ISO-week identity, mid-week cutoff stays blocked', async () => {
  // meta-less registry (foreign/legacy object, NOT provisionable - see B9): EVERYTHING blocked before any claim/provider access
  const blob0 = memBlob();
  const p0 = await blob0.put(REG_KEY, { v: 1, initializedAt: new Date().toISOString(), issues: {} });
  const rs0 = mockResend();
  let r = await D.dispatch(cfg, { ...model, date: '2020-01-05' }, '<html>', { blob: blob0, registryKey: REG_KEY, registryUrl: p0.url, segmentIdValue: 'seg1', topicIdValue: 'top1', resend: rs0.fn });
  assert.equal(r.error, 'blocked-legacy');
  assert.equal(r.reason, 'min-issue-week-missing');
  assert.equal(rs0.calls.create + rs0.calls.send + rs0.calls.list, 0, 'no provider access without meta');

  const blob = memBlob();
  const seed = { 'kifb-2026-W47': { state: 'blocked-legacy', reason: 'recovery-cutoff' } };
  const p = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '', seedIssues: seed, seedMeta: { minIssueWeek: '2026-W48' } });
  const rs = mockResend();
  const deps = { blob, registryKey: REG_KEY, registryUrl: p.url, segmentIdValue: 'seg1', topicIdValue: 'top1', resend: rs.fn };
  // seeded blocked-legacy key (2026-11-19 is ISO W47)
  r = await D.dispatch(cfg, { ...model, date: '2026-11-19' }, '<html>', deps);
  assert.equal(r.error, 'blocked-legacy');
  // mid-week cutoff: the FOLLOWING DAY of the same unreviewed week stays blocked
  r = await D.dispatch(cfg, { ...model, date: '2026-11-20' }, '<html>', deps);
  assert.equal(r.error, 'blocked-legacy');
  // unenumerated old date
  r = await D.dispatch(cfg, { ...model, date: '2020-01-05' }, '<html>', deps);
  assert.equal(r.reason, 'before-min-issue-week');
  // invalid calendar date passes no regex normalisation
  r = await D.dispatch(cfg, { ...model, date: '2026-13-40' }, '<html>', deps);
  assert.equal(r.reason, 'invalid-issue-date');
  assert.equal(rs.calls.create + rs.calls.send, 0, 'nothing sent for blocked issues');
  // first allowed week (2026-11-23 = W48) dispatches
  r = await D.dispatch(cfg, { ...model, date: '2026-11-23' }, '<html>', deps);
  assert.equal(r.ok, true);
  assert.equal(rs.calls.send, 1);
  const iss = await issues(blob, p.url);
  assert.equal(iss['kifb-2026-W47'].state, 'blocked-legacy', 'seed untouched');
  // canonical identity: 2026-11-24 is the SAME ISO week -> already-sent, no new claim
  r = await D.dispatch(cfg, { ...model, date: '2026-11-24' }, '<html>', deps);
  assert.equal(r.error, 'already-sent');
  assert.equal(rs.calls.send, 1, 'same ISO week shares one claim');
});

test('B3: sent/scheduled/queued broadcast with same name hard-blocks; foreign draft never adopted', async () => {
  const { deps } = await setup();
  const rs = mockResend();
  rs.broadcasts.set('bc_old', { id: 'bc_old', name: cfg.product + ' ' + model.weekLabel, status: 'sent', sent_at: '2026-10-25T06:00:00Z' });
  let r = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }));
  assert.equal(r.error, 'needs_review');
  assert.equal(r.reason, 'broadcast-exists-non-draft');
  assert.equal(rs.calls.send, 0);

  // foreign draft (same name, but not our segment/topic/from): never adopted
  const { deps: deps2 } = await setup();
  const rs2 = mockResend();
  rs2.broadcasts.set('bc_foreign', { id: 'bc_foreign', name: cfg.product + ' ' + model.weekLabel, status: 'draft', sent_at: null, segment_id: 'segOTHER', topic_id: 'topOTHER', from: 'other@x.de' });
  r = await D.dispatch(cfg, model, '<html>', deps2({ resend: rs2.fn }));
  assert.equal(r.error, 'needs_review');
  assert.equal(r.reason, 'draft-exists-unowned');
  assert.equal(rs2.calls.send, 0, 'no send over unowned draft');
  assert.equal(rs2.calls.create, 0, 'no second draft over unowned draft');
});

test('B4: bound draft with ANY tampered content/recipient field is never sent (full content binding)', async () => {
  const name = cfg.product + ' ' + model.weekLabel;
  const good = () => ({ id: 'bc_bound', name, status: 'draft', sent_at: null, segment_id: 'seg1', topic_id: 'top1', from: cfg.from, subject: model.subject, html: '<html>', reply_to: null });
  const cases = [
    ['subject', { subject: 'ALT BETREFF' }],
    ['html', { html: '<html>ALT</html>' }],
    ['reply_to extra address', { reply_to: ['a@b.de'] }],
    ['from', { from: 'other@x.de' }],
    ['segment_id', { segment_id: 'segOTHER' }],
    ['topic_id', { topic_id: 'topOTHER' }],
    ['status', { status: 'queued' }],
    ['name', { name: 'other name' }]
  ];
  for (const [label, tamper] of cases) {
    const { deps } = await setup();
    const m = await D.mutateRegistry(deps(), (iss) => { iss['kifb-2026-W43'] = { claimant: 'dead', state: 'failed-pre', reason: 'x', name, createdAt: '2026-10-25T06:00:00Z', broadcastId: 'bc_bound' }; });
    assert.equal(m.ok, true);
    const rs = mockResend();
    rs.broadcasts.set('bc_bound', { ...good(), ...tamper });
    const r = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }));
    assert.equal(r.error, 'needs_review', label);
    assert.equal(['broadcast-not-draft', 'broadcast-exists-non-draft', 'bound-draft-missing'].includes(r.reason), true, label + ': ' + JSON.stringify(r));
    assert.equal(rs.calls.send, 0, label + ': never sends');
  }
  // control: fully matching bound draft DOES send (binding is not over-blocking)
  const { deps } = await setup();
  await D.mutateRegistry(deps(), (iss) => { iss['kifb-2026-W43'] = { claimant: 'dead', state: 'failed-pre', reason: 'x', name, createdAt: '2026-10-25T06:00:00Z', broadcastId: 'bc_bound' }; });
  const rs = mockResend();
  rs.broadcasts.set('bc_bound', good());
  const ok = await D.dispatch(cfg, model, '<html>', deps({ resend: rs.fn }));
  assert.equal(ok.ok, true, 'matching bound draft sends: ' + JSON.stringify(ok));
  assert.equal(rs.calls.send, 1);
});

test('B5: damaged registry fails closed before any claim or provider call', async () => {
  const variants = [
    ['v999', (reg) => { reg.v = 999; }],
    ['issues array', (reg) => { reg.issues = []; }],
    ['unknown state', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'weird' }; }],
    ['claimed without claimant', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'claimed' }; }],
    ['sent without sentAt', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'sent', broadcastId: 'b' }; }],
    ['non-canonical key', (reg) => { reg.issues['evil-2026-W43'] = { state: 'blocked-legacy', reason: 'x' }; }],
    ['entry array', (reg) => { reg.issues['kifb-2026-W43'] = []; }],
    ['claimed without name', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'claimed', claimant: 'x', createdAt: '2026-10-25T06:00:00Z' }; }],
    ['claimed bad createdAt', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'claimed', claimant: 'x', name: 'n', createdAt: 'x' }; }],
    ['failed-pre without claimant', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'failed-pre', reason: 'x', name: 'n', createdAt: '2026-10-25T06:00:00Z' }; }],
    ['sent with incoherent provenance', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'sent', broadcastId: 'b', sentAt: '2026-10-25T07:00:00Z', claimant: 'x' }; }],
    ['locked without owner', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'locked' }; }],
    ['entry with unknown field', (reg) => { reg.issues['kifb-2026-W43'] = { state: 'claimed', claimant: 'x', name: 'n', createdAt: '2026-10-25T06:00:00Z', hacked: 'y' }; }],
    ['meta extra key', (reg) => { reg.meta.x = 1; }],
    ['meta wrong type', (reg) => { reg.meta = []; }],
    ['meta impossible week', (reg) => { reg.meta.minIssueWeek = '2026-W54'; }],
    ['initializedAt missing', (reg) => { delete reg.initializedAt; }],
    ['initializedAt impossible date', (reg) => { reg.initializedAt = '2026-02-30T00:00:00Z'; }],
    ['extra top-level key', (reg) => { reg.foo = 1; }]
  ];
  for (const [label, damage] of variants) {
    const blob = memBlob();
    const p = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '', seedMeta: { minIssueWeek: '2020-W01' } });
    const reg = (await blob.getWithEtag(p.url)).value;
    damage(reg);
    await blob.putCas(REG_KEY, reg, (await blob.getWithEtag(p.url)).etag);
    const rs = mockResend();
    const r = await D.dispatch(cfg, model, '<html>', { blob, registryKey: REG_KEY, registryUrl: p.url, resend: rs.fn, segmentIdValue: 'seg1', topicIdValue: 'top1' });
    assert.equal(r.error, 'registry-invalid', label + ': ' + JSON.stringify(r));
    assert.equal(rs.calls.create + rs.calls.send + rs.calls.list, 0, label + ': zero provider access');
  }
});

test('B8: invalid seed is rejected BEFORE any write (0 PUT); probe creation stays meta-free', async () => {
  const blob = memBlob();
  await assert.rejects(() => D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '', seedIssues: { 'kifb-2026-W47': { state: 'blocked-legacy', reason: 'x', unexpected: 'y' } }, seedMeta: { minIssueWeek: '2026-W48' } }), /seed-invalid/, 'extra seed field rejected pre-write');
  assert.equal(blob._map.size, 0, 'validation failure means ZERO persistent objects');
  const blob2 = memBlob();
  await assert.rejects(() => D.provisionRegistry({ blob: blob2, registryKey: REG_KEY, registryUrl: '', seedIssues: { 'kifb-2026-W47': { state: 'sent', broadcastId: 'b', sentAt: '2026-10-25T07:00:00Z', claimant: 'x' } }, seedMeta: { minIssueWeek: '2026-W48' } }), /seed-invalid/, 'incoherent provenance rejected pre-write');
  assert.equal(blob2._map.size, 0, 'validation failure means ZERO persistent objects');
  const blob3 = memBlob();
  const p = await D.provisionRegistry({ blob: blob3, registryKey: 'nl-probe/' + crypto.randomUUID() + '/registry.json', registryUrl: '', probe: true });
  assert.equal(p.created, true, 'meta-free probe creation unaffected');
});

test('B9: probe exclusivity is real - production targets always require validated meta, probe flag is target-bound', async () => {
  // regular target without seed/meta -> rejected BEFORE any write
  const b1 = memBlob();
  await assert.rejects(() => D.provisionRegistry({ blob: b1, registryKey: REG_KEY, registryUrl: '' }), /seed-invalid/, 'meta-free production create rejected');
  assert.equal(b1._map.size, 0, '0 PUT on rejection');
  // probe flag may not rescue a regular production target
  const b2 = memBlob();
  await assert.rejects(() => D.provisionRegistry({ blob: b2, registryKey: REG_KEY, registryUrl: '', probe: true }), /seed-invalid/, 'probe flag on regular target rejected');
  assert.equal(b2._map.size, 0, '0 PUT on probe-flag abuse');
  // probe flag with a non-random probe-ish key rejected too
  const b3 = memBlob();
  await assert.rejects(() => D.provisionRegistry({ blob: b3, registryKey: 'nl-probe/x/registry.json', registryUrl: '', probe: true }), /seed-invalid/, 'non-uuid probe target rejected');
  assert.equal(b3._map.size, 0, '0 PUT on fake probe target');
  // genuine internal probe creation stays meta-free
  const b4 = memBlob();
  const p4 = await D.provisionRegistry({ blob: b4, registryKey: 'nl-probe/' + crypto.randomUUID() + '/registry.json', registryUrl: '', probe: true });
  assert.equal(p4.created, true, 'internal probe creation unaffected');
  // production provisioning with validated meta works
  const b5 = memBlob();
  const p5 = await D.provisionRegistry({ blob: b5, registryKey: REG_KEY, registryUrl: '', seedMeta: { minIssueWeek: '2020-W01' } });
  assert.equal(p5.created, true, 'production provisioning with meta works');
});

test('B10: CLI --init without a validated seed file refuses before any write', async () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  let r;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'nl-registry-provision.js'), '--init'], { env: { ...process.env, NL_REGISTRY_URL: '', BLOB_READ_WRITE_TOKEN: 'fake-token' }, stdio: 'pipe' });
    r = { code: 0, err: '' };
  } catch (e) { r = { code: e.status, err: String(e.stderr) }; }
  assert.notEqual(r.code, 0, 'CLI --init without --seed refuses');
  assert.match(r.err, /--seed/, 'refusal names the mandatory seed file: ' + r.err);
});

test('B6: registry mutation BETWEEN reads locks the running dispatch (boundary pinned at every CAS read)', async () => {
  // blob wrapper whose Nth read returns a corrupted copy; putCas calls counted
  const rig = (blob, corrupt, corruptOnRead) => {
    let reads = 0; let writes = 0;
    const get0 = blob.getWithEtag; blob.getWithEtag = async (u) => {
      reads++;
      const r = await get0(u);
      if (r && reads >= corruptOnRead) { const v = JSON.parse(JSON.stringify(r.value)); corrupt(v); return { value: v, etag: r.etag }; }
      return r;
    };
    const cas0 = blob.putCas; blob.putCas = async (...a) => { writes++; return cas0(...a); };
    return { blob, writes: () => writes, rawGet: get0 };
  };
  const claimPhase = [
    ['meta dropped', (reg) => { delete reg.meta; }],
    ['boundary raised past this issue', (reg) => { reg.meta.minIssueWeek = '2026-W44'; }],
    ['boundary lowered (changed)', (reg) => { reg.meta.minIssueWeek = '2020-W02'; }],
    ['initializedAt dropped', (reg) => { delete reg.initializedAt; }],
    ['invalid entry injected', (reg) => { reg.issues['iw-2026-W43'] = { state: 'claimed' }; }]
  ];
  for (const [label, corrupt] of claimPhase) {
    const blob0 = memBlob();
    const p = await D.provisionRegistry({ blob: blob0, registryKey: REG_KEY, registryUrl: '', seedMeta: { minIssueWeek: '2020-W01' } });
    const { blob, writes, rawGet } = rig(blob0, corrupt, 2); // read 1 = dispatch read (clean), read 2 = claim CAS read (corrupted)
    const rs = mockResend();
    const r = await D.dispatch(cfg, model, '<html>', { blob, registryKey: REG_KEY, registryUrl: p.url, resend: rs.fn, segmentIdValue: 'seg1', topicIdValue: 'top1' });
    assert.equal(r.ok, false, label);
    assert.equal(r.error, 'registry-invalid', label + ': ' + JSON.stringify(r));
    assert.equal(rs.calls.create + rs.calls.send + rs.calls.list, 0, label + ': zero provider access');
    assert.equal(writes(), 0, label + ': corrupted state never written');
    const back = (await rawGet(p.url)).value; // uncorrupted final state
    assert.deepEqual(back.issues, {}, label + ': registry untouched');
    assert.equal(back.meta.minIssueWeek, '2020-W01', label + ': boundary untouched');
  }
  // mid-flight: claim succeeds, boundary lost at the NEXT transition read -> locked before send
  {
    const blob0 = memBlob();
    const p = await D.provisionRegistry({ blob: blob0, registryKey: REG_KEY, registryUrl: '', seedMeta: { minIssueWeek: '2020-W01' } });
    const { blob, writes, rawGet } = rig(blob0, (reg) => { delete reg.meta; }, 3);
    const rs = mockResend();
    const r = await D.dispatch(cfg, model, '<html>', { blob, registryKey: REG_KEY, registryUrl: p.url, resend: rs.fn, segmentIdValue: 'seg1', topicIdValue: 'top1' });
    assert.equal(r.ok, false, 'mid-flight loss locks dispatch');
    assert.equal(rs.calls.send, 0, 'never sends after boundary loss');
    const back = (await rawGet(p.url)).value; // uncorrupted final state
    assert.equal(back.meta.minIssueWeek, '2020-W01', 'boundary never overwritten by the corrupted read');
    assert.equal(back.issues['kifb-2026-W43'].state, 'claimed', 'only the pre-corruption claim was written');
    assert.equal(writes(), 1, 'exactly one (valid) write happened');
  }
});

test('B7: probe objects live in their own validator/namespace - production validation never loosens', async () => {
  const blob = memBlob();
  const p = await D.provisionRegistry({ blob, registryKey: REG_KEY, registryUrl: '', seedMeta: { minIssueWeek: '2020-W01' } });
  const reg = (await blob.getWithEtag(p.url)).value;
  reg.issues['probe-a'] = { state: 'claimed', claimant: 'probe' };
  assert.equal(D.validateRegistry(reg, { requireMeta: true, canonicalKeys: true }), false, 'probe entry rejected under production validation');
  const rs = mockResend();
  await blob.putCas(REG_KEY, reg, (await blob.getWithEtag(p.url)).etag);
  const r = await D.dispatch(cfg, model, '<html>', { blob, registryKey: REG_KEY, registryUrl: p.url, resend: rs.fn, segmentIdValue: 'seg1', topicIdValue: 'top1' });
  assert.equal(r.error, 'registry-invalid', 'dispatch refuses a registry carrying probe entries');
  assert.equal(rs.calls.create + rs.calls.send + rs.calls.list, 0);
  // probe registry (no meta, probe-* keys) validates ONLY under the probe validator
  const pb = memBlob();
  const probeKey = 'nl-probe/' + crypto.randomUUID() + '/registry.json';
  const pp = await D.provisionRegistry({ blob: pb, registryKey: probeKey, registryUrl: '', probe: true });
  const m = await D.mutateRegistry({ blob: pb, registryKey: probeKey, registryUrl: pp.url, validator: D.validateProbeRegistry }, (iss) => { iss['probe-m1'] = { state: 'claimed', claimant: 'probe' }; });
  assert.equal(m.ok, true, 'probe CAS works under the probe validator');
  const preg = (await pb.getWithEtag(pp.url)).value;
  assert.equal(D.validateProbeRegistry(preg), true);
  assert.equal(D.validateRegistry(preg, { requireMeta: true, canonicalKeys: true }), false, 'probe registry NEVER valid under production validation');
  const grown = JSON.parse(JSON.stringify(preg));
  grown.issues['probe-m1'].name = 'sneaky';
  assert.equal(D.validateProbeRegistry(grown), false, 'probe entries may not grow fields');
  const prodKey = JSON.parse(JSON.stringify(preg));
  prodKey.issues['kifb-2026-W43'] = { state: 'claimed', claimant: 'probe' };
  assert.equal(D.validateProbeRegistry(prodKey), false, 'production keys rejected under probe validation');
});
