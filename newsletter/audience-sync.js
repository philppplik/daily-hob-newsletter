'use strict';
// Durable per-consent-event audience sync (reviewer R4-R6 + 16:10 blockers).
//
// Rule set:
// - A consent event = rec.confirmedAt (+ nlOptIn===true). Each event is applied to the
//   provider AT MOST ONCE. Once 'applied', provider preferences win forever: a
//   provider-page unsubscribe is never undone by a re-sync.
// - The 'attempting' marker is claimed ATOMICALLY (CAS on the record's ETag) BEFORE
//   any external call: two concurrent confirms cannot both opt-in; the loser gets
//   'locked' and stops. If the marker write fails, no provider call has happened.
// - Order: contact ensure + segment join first, topic opt_in LAST. Failures before the
//   opt-in are 'failed-pre' (no topic write happened, retry is safe). A failed or
//   timed-out opt-in is 'unknown' (possibly applied server-side) and is NEVER blindly
//   retried.
// - There is NO documented GET endpoint for a contact's topic subscriptions (PATCH +
//   webhook only, reviewer 16:10). 'unknown'/'attempting'-stale states therefore go to
//   needs_review (bounded, fail-closed, manual recovery via dashboard) - no guessed
//   reads, no new webhook infrastructure.
// - A marker write failure AFTER a successful opt-in leaves 'attempting' on disk ->
//   needs_review on the next run, never a blind re-opt-in.
// - An absent marker is NOT assumed to mean 'never applied': applyConsent runs only on
//   the fresh-consent path (confirm / eligible dispatch records); anything not
//   provably safe blocks.

// opt-out is idempotent-safe to retry; 'ok' means the provider ACCEPTED the request
// (there is no documented GET for topic state, so acceptance is all that can be shown).
async function applyOptOut(L, rec, site) {
  const topicId = L.weeklyTopic(site);
  if (!topicId) return { status: 'unconfigured' };
  try {
    await L.topicSubscribe(rec.email, topicId, 'opt_out');
    return { status: 'ok' };
  } catch (e) {
    return { status: 'failed', error: String(e && e.message || e) };
  }
}

async function applyConsent(deps, rec) {
  const { L, store, site } = deps;
  const now = () => new Date().toISOString();
  const id = L.idOf(rec.email);
  const consentAt = rec.confirmedAt;
  const segId = L.weeklySegmentId(site);
  const topicId = L.weeklyTopic(site);
  if (!segId || !topicId) return { status: 'unconfigured' };
  const cur = rec.nlSync;
  if (cur && cur.consentAt === consentAt) {
    if (cur.state === 'applied') return { status: 'already-applied' };
    if (cur.state === 'unknown' || cur.state === 'attempting') {
      // never blind-retry an opt-in whose outcome is not provably clean; there is no
      // documented provider read for topic subscriptions -> bounded fail-closed.
      return { status: 'needs-review', reason: 'opt-in-' + cur.state };
    }
    // 'failed-pre' falls through: no topic opt-in was ever attempted, retry is safe
  }
  // atomic claim of the attempting-marker BEFORE any external call (CAS on the record)
  const got = await store.getWithEtag(id);
  if (!got || !got.value) return { status: 'record-missing' };
  const fresh = got.value;
  // evaluate the DURABLE state (the passed rec may be stale); no recursion:
  // unsubscribe guard: a durable nlUnsub marker for this site wins over any opt-in
  if (fresh.nlUnsub && fresh.nlUnsub[site]) return { status: 'unsubscribed' };
  const fs = fresh.nlSync;
  if (fs && fs.consentAt === consentAt) {
    if (fs.state === 'applied') return { status: 'already-applied' };
    if (fs.state === 'unknown' || fs.state === 'attempting') return { status: 'needs-review', reason: 'opt-in-' + fs.state };
    // failed-pre: safe to retry below
  }
  fresh.nlSync = { consentAt, state: 'attempting', at: now() };
  const claimed = await store.putCas(id, fresh, got.etag);
  if (!claimed) return { status: 'locked' }; // a concurrent claim won; stop
  rec = fresh;
  try {
    await L.ensureContact(rec.email);
    await L.segmentJoin(rec.email, segId);
  } catch (e) {
    await store.mutateCas(id, (r) => { r.nlSync = { consentAt, state: 'failed-pre', error: String(e && e.message || e), at: now() }; }).catch(() => {});
    return { status: 'failed-pre', error: String(e && e.message || e) };
  }
  try {
    await L.topicSubscribe(rec.email, topicId, 'opt_in');
  } catch (e) {
    await store.mutateCas(id, (r) => { r.nlSync = { consentAt, state: 'unknown', error: String(e && e.message || e), at: now() }; }).catch(() => {});
    return { status: 'unknown', error: String(e && e.message || e) };
  }
  // ordering reconcile: a concurrent unsubscribe may have landed DURING the in-flight
  // opt-in (nl-unsub does not hold our claim). CAS alone cannot order across the
  // provider, so we re-read: if an unsub marker appeared, the opt-out is applied
  // immediately after - the provider ends opted OUT.
  const after = await store.getWithEtag(id).catch(() => null);
  if (after && after.value && after.value.nlUnsub && after.value.nlUnsub[site]) {
    const out = await applyOptOut(L, rec, site);
    await store.mutateCas(id, (r) => {
      r.nlSync = { consentAt, state: 'undone-unsub', at: now() };
      r.nlUnsub = Object.assign({}, r.nlUnsub, { [site]: { at: (r.nlUnsub[site] && r.nlUnsub[site].at) || now(), provider: out.status === 'ok' ? 'ok' : 'failed', error: out.error } });
    }).catch(() => {});
    return { status: 'undone-unsub', optOut: out.status };
  }
  const w = await store.mutateCas(id, (r) => { r.nlSync = { consentAt, state: 'applied', at: now() }; }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  if (!w.ok) return { status: 'unknown', error: w.error || 'applied-marker-write-failed' }; // disk may keep 'attempting' -> needs_review next run
  return { status: 'applied' };
}

module.exports = { applyConsent, applyOptOut };
