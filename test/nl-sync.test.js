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
