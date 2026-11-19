'use strict';
// R6: real tests for the durable per-consent-event sync state machine.
process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../api/_lw');
const sync = require('../newsletter/audience-sync');

const store = () => L.storeFor('optin/');
function mkL(over = {}) {
  return {
    ...L,
    weeklySegmentId: () => 'seg1',
    weeklyTopic: () => 'top1',
    ensureContact: async () => 'created',
    segmentJoin: async () => {},
    topicSubscribe: async () => {},
    topicList: async () => ({ topics: [{ id: 'top1', subscription: 'opt_out' }] }),
    contactGet: async () => ({ exists: true }),
    ...over
  };
}
const rec = (email) => ({ email, confirmedAt: '2026-10-24T10:00:00Z', nlOptIn: true });

test('S1: fresh consent -> durable attempting-marker BEFORE any provider call, then applied once', async () => {
  const st = store(); const r = rec('s1@test.de'); await st.put(L.idOf(r.email), r);
  const order = [];
  const lm = mkL({ topicSubscribe: async () => { order.push('opt_in'); } });
  const origCas = st.putCas.bind(st);
  st.putCas = async (id, v, etag) => { if (v.nlSync && v.nlSync.state === 'attempting') order.push('marker'); return origCas(id, v, etag); };
  const out = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out.status, 'applied');
  assert.deepEqual(order.slice(0, 2), ['marker', 'opt_in'], 'marker is durable before the external opt-in');
  const saved = await st.get(L.idOf(r.email));
  assert.equal(saved.nlSync.state, 'applied');
  assert.equal(saved.nlSync.consentAt, r.confirmedAt);
});

test('S2: marker write fails AFTER successful opt-in -> never blind re-opt-in (needs-review, 1 opt-in total)', async () => {
  const st = store(); const r = rec('s2@test.de'); await st.put(L.idOf(r.email), r);
  let optIns = 0;
  const origCas = st.putCas.bind(st);
  let markerWrites = 0;
  st.putCas = async (id, v, etag) => {
    if (v.nlSync && v.nlSync.state === 'attempting') markerWrites++;
    if (v.nlSync && v.nlSync.state === 'applied') throw new Error('blob down');
    return origCas(id, v, etag);
  };
  const lm = mkL({ topicSubscribe: async () => { optIns++; } });
  const out1 = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out1.status, 'unknown', 'failed applied-marker write is reported, not hidden');
  assert.equal(optIns, 1);
  assert.equal(markerWrites, 1, 'single atomic attempting claim');
  const saved = await st.get(L.idOf(r.email));
  assert.equal(saved.nlSync.state, 'attempting', 'disk keeps attempting after marker-write failure');
  st.putCas = origCas;
  const out2 = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, saved);
  assert.equal(out2.status, 'needs-review', 'no documented provider read -> bounded fail-closed, no blind retry');
  assert.equal(optIns, 1, 'still exactly one opt-in');
});

test('S3: opt-in outcome unknown -> needs-review, NO blind retry', async () => {
  const st = store(); const r = rec('s3@test.de'); await st.put(L.idOf(r.email), r);
  let optIns = 0;
  const lm = mkL({ topicSubscribe: async () => { optIns++; throw new Error('timeout after write?'); } });
  const out1 = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out1.status, 'unknown');
  const saved = await st.get(L.idOf(r.email));
  assert.equal(saved.nlSync.state, 'unknown');
  const out2 = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, saved);
  assert.equal(out2.status, 'needs-review');
  assert.equal(optIns, 1, 'unknown opt-in is never blindly retried');
});

test('S4: pre-opt-in failure (contact/segment) is failed-pre and safely retryable', async () => {
  const st = store(); const r = rec('s4@test.de'); await st.put(L.idOf(r.email), r);
  let optIns = 0; let joins = 0;
  const lm = mkL({
    segmentJoin: async () => { joins++; if (joins === 1) throw new Error('resend 500'); },
    topicSubscribe: async () => { optIns++; }
  });
  const out1 = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out1.status, 'failed-pre');
  assert.equal(optIns, 0, 'no opt-in attempted');
  const saved = await st.get(L.idOf(r.email));
  const out2 = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, saved);
  assert.equal(out2.status, 'applied', 'failed-pre retries cleanly');
  assert.equal(optIns, 1);
});

test('S5: applied consent + later provider opt-out -> applyConsent never re-opts-in', async () => {
  const st = store();
  const r = rec('s5@test.de');
  r.nlSync = { consentAt: r.confirmedAt, state: 'applied', at: '2026-10-24T10:00:01Z' };
  await st.put(L.idOf(r.email), r);
  let optIns = 0;
  const lm = mkL({ topicSubscribe: async () => { optIns++; } });
  const out = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out.status, 'already-applied');
  assert.equal(optIns, 0, 'provider preferences win: no re-opt-in after applied');
});

test('S6: consent changed after application (re-confirm) is a fresh event and applies once more', async () => {
  const st = store();
  const r = rec('s6@test.de');
  r.confirmedAt = '2026-10-24T12:00:00Z'; // newer consent event
  r.nlSync = { consentAt: '2026-10-20T10:00:00Z', state: 'applied', at: '2026-10-20T10:00:01Z' };
  await st.put(L.idOf(r.email), r);
  let optIns = 0;
  const lm = mkL({ topicSubscribe: async () => { optIns++; } });
  const out = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out.status, 'applied');
  assert.equal(optIns, 1, 'fresh consent event applies exactly once');
});

test('S7: two concurrent confirms -> exactly one opt-in (CAS marker claim)', async () => {
  const st = store(); const r = rec('s7@test.de'); await st.put(L.idOf(r.email), r);
  let optIns = 0;
  const lm = mkL({ topicSubscribe: async () => { optIns++; await new Promise((x) => setTimeout(x, 10)); } });
  const [a, b] = await Promise.all([
    sync.applyConsent({ L: lm, store: st, site: 'fa' }, r),
    sync.applyConsent({ L: lm, store: st, site: 'fa' }, { ...r })
  ]);
  const stats = [a.status, b.status].sort();
  assert.equal(optIns, 1, 'exactly one opt-in under concurrency: ' + JSON.stringify([a, b]));
  assert.ok(stats.includes('applied'), JSON.stringify(stats));
  assert.ok(stats.includes('needs-review') || stats.includes('locked') || stats.includes('applied'), JSON.stringify(stats));
});

test('S8: concurrent unsubscribe during in-flight opt-in -> both fields survive, provider ends opted OUT', async () => {
  const st = store(); const r = rec('s8@test.de'); await st.put(L.idOf(r.email), r);
  const calls = [];
  const lm = mkL({
    topicSubscribe: async (email, t, sub) => {
      calls.push(sub);
      if (sub === 'opt_in') {
        // unsubscribe lands mid-flight (CAS-only, like api/nl-unsub)
        await st.mutateCas(L.idOf(r.email), (x) => { x.nlUnsub = { fa: { at: '2026-10-24T11:00:00Z', provider: 'pending' } }; });
      }
    }
  });
  const out = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out.status, 'undone-unsub', 'late opt-in detected and reconciled: ' + JSON.stringify(out));
  assert.deepEqual(calls, ['opt_in', 'opt_out'], 'provider ordering: opt-out applied after the in-flight opt-in');
  const saved = await st.get(L.idOf(r.email));
  assert.ok(saved.confirmedAt, 'consent fields preserved');
  assert.ok(saved.nlUnsub && saved.nlUnsub.fa, 'unsub marker preserved (no clobber)');
  assert.equal(saved.nlUnsub.fa.provider, 'ok');
  assert.equal(saved.nlSync.state, 'undone-unsub');
});

test('S9: durable unsub marker suppresses any later opt-in attempt', async () => {
  const st = store(); const r = rec('s9@test.de');
  r.nlUnsub = { fa: { at: '2026-10-24T11:00:00Z', provider: 'ok' } };
  await st.put(L.idOf(r.email), r);
  let optIns = 0;
  const lm = mkL({ topicSubscribe: async () => { optIns++; } });
  const out = await sync.applyConsent({ L: lm, store: st, site: 'fa' }, r);
  assert.equal(out.status, 'unsubscribed');
  assert.equal(optIns, 0, 'no opt-in over a durable unsub marker');
});

test('S10: CAS contention preserves concurrent fields (no clobber, bounded retry)', async () => {
  const st = store(); const r = rec('s10@test.de'); await st.put(L.idOf(r.email), r);
  // two field mutations race; both must land
  const [a, b] = await Promise.all([
    st.mutateCas(L.idOf(r.email), (x) => { x.confirmedAt = '2026-10-24T12:00:00Z'; }),
    st.mutateCas(L.idOf(r.email), (x) => { x.nlUnsub = { fa: { at: '2026-10-24T12:00:01Z', provider: 'ok' } }; })
  ]);
  const saved = await st.get(L.idOf(r.email));
  assert.ok(a.ok || b.ok, 'at least one wins immediately');
  assert.equal(saved.confirmedAt, '2026-10-24T12:00:00Z', 'field A preserved');
  assert.equal(saved.nlUnsub.fa.provider, 'ok', 'field B preserved');
});

test('U1: opt-out verified by topic GET -> ok, and no ensureContact on unsubscribe', async () => {
  let ensured = 0;
  const lm = mkL({
    ensureContact: async () => { ensured++; },
    topicSubscribe: async () => {},
    topicList: async () => ({ topics: [{ id: 'top1', subscription: 'opt_out' }] })
  });
  const out = await sync.applyOptOut(lm, rec('u1@test.de'), 'fa');
  assert.equal(out.status, 'ok');
  assert.equal(ensured, 0, 'unsubscribe must not create provider state');
});

test('U2: accepted PATCH but topic not opt_out in read proof -> unknown, marker NOT resolved', async () => {
  const lm = mkL({
    topicSubscribe: async () => {},
    topicList: async () => ({ topics: [{ id: 'top1', subscription: 'opt_in' }] })
  });
  const out = await sync.applyOptOut(lm, rec('u2@test.de'), 'fa');
  assert.equal(out.status, 'unknown', 'acceptance without read proof is never success');
});

test('U3: PATCH 404 is not-present ONLY with direct contact-GET 404 (no blanket 404 success)', async () => {
  const e = new Error('topic-subscribe 404'); e.code = 'contact-not-found';
  const lm = mkL({ topicSubscribe: async () => { throw e; }, contactGet: async () => ({ notFound: true }) });
  const out = await sync.applyOptOut(lm, rec('u3@test.de'), 'fa');
  assert.equal(out.status, 'not-present');
  const lm2 = mkL({ topicSubscribe: async () => { throw e; }, contactGet: async () => ({ exists: true }) });
  const out2 = await sync.applyOptOut(lm2, rec('u3b@test.de'), 'fa');
  assert.equal(out2.status, 'failed', 'topic 404 with existing contact stays failed');
  const lm3 = mkL({ topicSubscribe: async () => { throw e; }, contactGet: async () => { throw new Error('contact-read 500'); } });
  const out3 = await sync.applyOptOut(lm3, rec('u3c@test.de'), 'fa');
  assert.equal(out3.status, 'failed', 'unreadable contact stays failed');
});

test('U4: provider 422 stays failed (regression: no blanket success on wrong payload)', async () => {
  const lm = mkL({ topicSubscribe: async () => { throw new Error('topic-subscribe 422'); } });
  const out = await sync.applyOptOut(lm, rec('u4@test.de'), 'fa');
  assert.equal(out.status, 'failed');
  assert.match(out.error, /422/);
});

test('U5: topicSubscribe sends documented bare-array body; ensure skipped only for opt-out', async () => {
  const L2 = require('../api/_lw');
  const prevMail = process.env.LW_MAIL; const prevKey = process.env.RESEND_API_KEY;
  process.env.LW_MAIL = ''; process.env.RESEND_API_KEY = 'test-key';
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body }); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    await L2.topicSubscribe('u5@test.de', 'top1', 'opt_out', { ensure: false });
    assert.equal(calls.length, 1, 'no ensureContact fetch on opt-out');
    assert.deepEqual(JSON.parse(calls[0].body), [{ id: 'top1', subscription: 'opt_out' }], 'bare array body');
    calls.length = 0;
    await L2.topicSubscribe('u5@test.de', 'top1', 'opt_in');
    assert.equal(calls.length, 2, 'opt-in ensures contact first');
    assert.deepEqual(JSON.parse(calls[1].body), [{ id: 'top1', subscription: 'opt_in' }]);
  } finally {
    global.fetch = origFetch; process.env.LW_MAIL = prevMail; process.env.RESEND_API_KEY = prevKey;
  }
});

test('U6: topicList strict pagination (real helper, stubbed fetch)', async () => {
  const L2 = require('../api/_lw');
  const prevMail = process.env.LW_MAIL; const prevKey = process.env.RESEND_API_KEY;
  process.env.LW_MAIL = ''; process.env.RESEND_API_KEY = 'test-key';
  const origFetch = global.fetch;
  const run = async (pages) => {
    let i = 0;
    global.fetch = async () => { const p = pages[Math.min(i++, pages.length - 1)]; return { ok: p.ok !== false, status: p.status || 200, json: async () => p.body }; };
    return L2.topicList('u6@test.de');
  };
  try {
    // two complete pages aggregate
    const ok = await run([
      { body: { data: [{ id: 'a', subscription: 'opt_out' }], has_more: true } },
      { body: { data: [{ id: 'b', subscription: 'opt_in' }], has_more: false } }
    ]);
    assert.deepEqual(ok.topics, [{ id: 'a', subscription: 'opt_out' }, { id: 'b', subscription: 'opt_in' }]);
    // has_more with empty page -> error, never partial success
    await assert.rejects(() => run([{ body: { data: [], has_more: true } }]), /page-empty/);
    // has_more without cursor -> error
    await assert.rejects(() => run([{ body: { data: [{ id: null }], has_more: true } }]), /cursor-missing/);
    // repeated cursor -> error
    await assert.rejects(() => run([{ body: { data: [{ id: 'a', subscription: 'opt_out' }], has_more: true } }]), /cursor-repeat/);
    // error on a FOLLOW page fails even with opt_out in the first fragment
    await assert.rejects(() => run([
      { body: { data: [{ id: 'a', subscription: 'opt_out' }], has_more: true } },
      { status: 500, ok: false, body: {} }
    ]), /topic-list 500/);
    // 404 only accepted on the first page
    const nf = await run([{ status: 404, ok: false, body: {} }]);
    assert.deepEqual(nf, { notFound: true });
    await assert.rejects(() => run([
      { body: { data: [{ id: 'a', subscription: 'opt_out' }], has_more: true } },
      { status: 404, ok: false, body: {} }
    ]), /topic-list 404/);
  } finally {
    global.fetch = origFetch; process.env.LW_MAIL = prevMail; process.env.RESEND_API_KEY = prevKey;
  }
});
