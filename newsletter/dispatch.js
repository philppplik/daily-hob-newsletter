'use strict';
// Rail-A dispatch with draft-first + registry-CAS ownership. Storage facts are from
// the LIVE probe (publisher, 24.10. 16:20) - they override SDK-doc assumptions:
// - x-allow-overwrite '0' and x-if-none-match are IGNORED (2nd PUT 200; 8 parallel
//   creates -> 7-8 "winners"). There is NO atomic create, so this design NEVER
//   creates or overwrites a shared key unconditionally. Every runtime write is a CAS.
// - CAS works: x-if-match <etag>, stale -> 412, 6 parallel CAS on one etag -> exactly
//   1 winner. ETag comes from GET ?cache=0 on the canonical URL; a missing ETag is a
//   HARD FAIL. API version must be 7 (v12/13 -> Invalid pathname).
// - Read-after-write is consistent; delete is 200 then 404.
// - Hosts are never constructed unchecked: the registry is read via its canonical URL
//   (NL_REGISTRY_URL, captured from the provisioning PUT response); CAS writes go to
//   the canonical PUT endpoint (API host + pathname). A BLOB_STORE_ID carrying a
//   store_prefix produced a bad host (400) in the probe.
//
// Ownership (reviewer-converged registry CAS map):
// - ONE pre-existing global registry record (default key nl-registry/registry.json,
//   shape { v:1, initializedAt, issues: { '<site>-<date>': { claimant, state, ... } } }).
//   It is created EXACTLY ONCE by the offline provisioning script
//   (scripts/nl-registry-provision.js) while dispatch is disabled. There is NO online
//   init endpoint and NO auto-create anywhere: a missing/unreadable registry is FATAL
//   for dispatch, and the provisioner refuses to write when a record already exists
//   (a stale-404 overwrite after an active claim/send would be catastrophic, so the
//   provisioner never PUTs over an existing registry - it inspects instead).
// - Every claim/transition is a bounded read-merge-CAS on the registry: re-read on
//   412, re-merge, retry. Concurrent claims of DIFFERENT issues merge-preserve (both
//   survive); concurrent claims of the SAME issue have exactly one winner.
// - No record is ever adopted: someone else's 'claimed'/'draft'/'sending' -> 'locked';
//   'sent' and 'needs_review' are terminal. Issue keys are NEVER pruned - 'sent'
//   tombstones are what prevents an old issue from being re-sent.
// - 'failed-pre' (failure BEFORE any external call) is the one take-overable state:
//   exactly one retrier wins the CAS. A crashed run otherwise needs a manual operator
//   reset routed via main - never automatic, no force parameter anywhere.
//
// Provider facts (review-verified, resend.com docs):
// - Broadcast create+send:true commits immediately; drafts (send:false, default)
//   never send themselves -> all concurrency is resolved while nothing can send.
// - POST /broadcasts/:id/send double-call semantics are UNDOCUMENTED -> exactly one
//   send call per broadcast id, only after the CAS into 'sending' and a fresh GET
//   showing status 'draft'. Ambiguous send result -> status-only reconcile or
//   needs_review HARD STOP, NEVER an automatic resend.
// - Every broadcast REQUIRES segment_id AND topic_id here: both mandatory, so an
//   absent topic can never fan out to a whole segment.

const crypto = require('crypto');

const API = 'https://blob.vercel-storage.com';
function blobAuth() {
  return { authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN, 'x-api-version': '7', 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0' };
}
const REGISTRY_KEY = () => process.env.NL_REGISTRY_KEY || 'nl-registry/registry.json';
const REGISTRY_URL = () => process.env.NL_REGISTRY_URL || ''; // canonical URL from the offline provisioning output

const blob = {
  // Plain PUT - ONLY for the offline provisioner and probe keys (unique/disposable),
  // NEVER for runtime dispatch writes. Returns the canonical URL from the response.
  async put(key, value) {
    const r = await fetch(API + '/' + key, { method: 'PUT', headers: { ...blobAuth(), 'x-allow-overwrite': '1', 'x-content-type': 'application/json' }, body: JSON.stringify(value) });
    if (!r.ok) throw new Error('blob-put ' + r.status);
    const j = await r.json().catch(() => ({}));
    if (!j.url) throw new Error('blob-put-no-url');
    return { url: j.url, pathname: j.pathname || key };
  },
  // Read via a canonical URL (env/probe-provided), cache bypassed; ETag hard-required.
  async getWithEtag(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'cache=0', { headers: blobAuth() });
    if (!r.ok) return null;
    const etag = r.headers.get('etag');
    if (!etag) throw new Error('blob-etag-missing (hard fail: CAS impossible without ETag)');
    return { value: await r.json(), etag };
  },
  // compare-and-swap via the canonical PUT endpoint. 412 -> false.
  async putCas(key, value, etag) {
    if (!etag) throw new Error('blob-etag-missing (hard fail: refusing CAS without ETag)');
    const r = await fetch(API + '/' + key, { method: 'PUT', headers: { ...blobAuth(), 'x-allow-overwrite': '1', 'x-if-match': etag, 'x-content-type': 'application/json' }, body: JSON.stringify(value) });
    if (r.status === 412) return false;
    if (!r.ok) throw new Error('blob-putCas ' + r.status);
    return true;
  },
  async del(url) {
    await fetch(API + '/delete', { method: 'POST', headers: { ...blobAuth(), 'content-type': 'application/json' }, body: JSON.stringify({ urls: [url] }) }).catch(() => {});
  },
  // Raw HTTP status for a canonical URL. Cleanup verification only: a confirmed 404
  // proves absence; any other status/transport failure (403/500/0) proves NOTHING.
  async status(url) {
    try { const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'cache=0', { headers: blobAuth() }); return r.status; } catch (e) { return 0; }
  },
  // Prefix listing for the OFFLINE provisioner only; FAIL CLOSED on any list error
  // or pagination (never reason over a partial/absence-unproven list).
  async list(prefix) {
    const r = await fetch(API + '/?prefix=' + encodeURIComponent(prefix) + '&limit=1000', { headers: blobAuth() });
    if (!r.ok) throw new Error('blob-list ' + r.status + ' (fail closed: no absence proof)');
    const j = await r.json();
    if (j.hasMore) throw new Error('blob-list-paginated (fail closed: no absence proof)');
    return (j.blobs || []).map((x) => ({ url: x.url, pathname: x.pathname || '' })).filter((x) => x.url && x.pathname);
  }
};

// Offline provisioning logic (shared by scripts/nl-registry-provision.js and the
// probe's refuse-overwrite check). NEVER overwrites an existing registry: with an
// existing record it only inspects. Returns { created, url, registry }.
async function provisionRegistry(deps) {
  const b = (deps && deps.blob) || blob;
  const key = (deps && deps.registryKey) || REGISTRY_KEY();
  // Explicit vs missing: an explicitly passed registryUrl ('' = provision fresh at
  // registryKey, used by the storage probe) must NOT fall back to the production env URL.
  const url = deps && Object.prototype.hasOwnProperty.call(deps, 'registryUrl') ? deps.registryUrl : REGISTRY_URL();
  if (url) {
    const got = await b.getWithEtag(url);
    if (got) return { created: false, url, registry: got.value }; // exists: inspect only, never PUT
    // URL configured but unreadable: ambiguous state - refuse, never blind-PUT.
    throw new Error('registry-url-unreadable (fail closed: refusing to create over an ambiguous state)');
  }
  // No URL known (e.g. env lost): a blind PUT could overwrite an existing registry
  // WITH tombstones. Require an actual LIST absence proof for the exact key first.
  // Any list error/pagination fails closed (see blob.list). LIST is NOT atomic, so
  // this stays an offline, operationally exclusive step while dispatch is disabled.
  const found = await b.list(key);
  const hit = found.find((x) => x.pathname === key);
  if (hit) {
    const got = await b.getWithEtag(hit.url);
    if (!got) throw new Error('registry-listed-but-unreadable (fail closed)');
    return { created: false, url: hit.url, registry: got.value }; // exists: inspect only
  }
  const init = { v: 1, initializedAt: new Date().toISOString(), issues: {} };
  const put = await b.put(key, init);
  // verify durable initialized state before anything may rely on it
  const back = await b.getWithEtag(put.url);
  if (!back || !back.value || back.value.v !== 1 || !back.value.issues) throw new Error('provision-verify-failed');
  return { created: true, url: put.url, registry: back.value };
}

// Bounded read-merge-CAS on the registry. fn(issues) mutates the issues map in place
// and may return false to abort. Retries on 412 with a fresh read (merge-preserving);
// NEVER falls back to a plain write. deps: { blob, registryKey, registryUrl }.
async function mutateRegistry(deps, fn, attempts = 4) {
  const b = deps.blob || blob;
  const key = deps.registryKey || REGISTRY_KEY();
  const url = deps.registryUrl || REGISTRY_URL();
  if (!url) return { ok: false, error: 'registry-missing' }; // no auto-create, ever
  for (let i = 0; i < attempts; i++) {
    const got = await b.getWithEtag(url);
    if (!got) return { ok: false, error: 'registry-missing' }; // fatal: never init online
    const reg = got.value && typeof got.value === 'object' ? got.value : {};
    reg.issues = reg.issues && typeof reg.issues === 'object' ? reg.issues : {};
    const out = await fn(reg.issues);
    if (out === false) return { ok: false, error: 'aborted', issues: reg.issues };
    if (await b.putCas(key, reg, got.etag)) return { ok: true, issues: reg.issues, result: out };
  }
  return { ok: false, error: 'cas-contention' };
}
async function readRegistry(deps) {
  const b = deps.blob || blob;
  const url = deps.registryUrl || REGISTRY_URL();
  if (!url) return null;
  const got = await b.getWithEtag(url);
  return got && got.value && got.value.issues ? got.value.issues : null;
}

// Live capability probe (scoped: DISPOSABLE nl-probe/ registry + keys, cleaned up,
// never mail, NEVER the production registry). Verifies exactly what this design
// depends on. Must pass once before NL_CAS_VERIFIED=1 is set.
async function probeStorage(deps) {
  const b = (deps && deps.blob) || blob;
  const pfx = 'nl-probe/' + crypto.randomUUID() + '/';
  const regKey = pfx + 'registry.json';
  const urls = [];
  // Track every canonical URL the moment a PUT succeeds, so cleanup knows created
  // probe objects even when a later verification step throws before returning.
  const tracked = Object.create(b);
  tracked.put = async (k, v) => { const r = await b.put(k, v); if (r && r.url) urls.push(r.url); return r; };
  // Inner checks may return early on any failure; cleanup+verification ALWAYS runs
  // afterwards for every created probe URL, and a cleanup failure is always visible
  // without masking the original finding.
  let result;
  try {
    result = await (async () => {
      // P0 read-only attestation of the ACTUAL configured registry (never written):
      // proves the configured URL + adapter credentials before any disposable-path test.
      const cfgUrl = REGISTRY_URL();
      if (cfgUrl) {
        const got0 = await b.getWithEtag(cfgUrl);
        if (!got0 || !got0.value || !got0.value.issues) return { ok: false, step: 'P0-configured-registry-unreadable' };
      }
      // P1 provision creates + verifies; P2 provision REFUSES to overwrite an existing
      // registry (the stale-404 overwrite path must not exist in code)
      const p1 = await provisionRegistry({ blob: tracked, registryKey: regKey, registryUrl: '' });
      if (!p1.created) return { ok: false, step: 'P1-provision-create-failed' };
      const p2 = await provisionRegistry({ blob: b, registryKey: regKey, registryUrl: p1.url });
      if (p2.created) return { ok: false, step: 'P2-provision-overwrote-existing' };
      // P3 read-after-write + ETag presence on the canonical URL
      const g = await b.getWithEtag(p1.url);
      if (!g || g.value.v !== 1) return { ok: false, step: 'P3-read-after-write-failed' };
      // P4 CAS with current etag succeeds; P5 stale etag -> 412 (false)
      const reg = g.value;
      reg.issues['probe-a'] = { state: 'claimed' };
      if (!await b.putCas(regKey, reg, g.etag)) return { ok: false, step: 'P4-current-cas-failed' };
      if (await b.putCas(regKey, reg, g.etag) !== false) return { ok: false, step: 'P5-stale-cas-not-rejected' };
      // P6 parallel CAS on one etag -> exactly one winner
      const g6 = await b.getWithEtag(p1.url);
      const wins = await Promise.all(Array.from({ length: 6 }, (_, i) => {
        const r6 = JSON.parse(JSON.stringify(g6.value));
        r6.issues['probe-r' + i] = { state: 'claimed' };
        return b.putCas(regKey, r6, g6.etag).catch(() => 'err');
      }));
      if (wins.filter((w) => w === true).length !== 1) return { ok: false, step: 'P6-parallel-cas-not-exclusive', wins: wins.filter((w) => w === true).length };
      // P7 concurrent different-issue claims merge-preserve (both survive)
      const [m1, m2] = await Promise.all([
        mutateRegistry({ blob: b, registryKey: regKey, registryUrl: p1.url }, (issues) => { issues['probe-m1'] = { state: 'claimed' }; }),
        mutateRegistry({ blob: b, registryKey: regKey, registryUrl: p1.url }, (issues) => { issues['probe-m2'] = { state: 'claimed' }; })
      ]);
      const g7 = await b.getWithEtag(p1.url);
      if (!m1.ok || !m2.ok || !g7.value.issues['probe-m1'] || !g7.value.issues['probe-m2']) return { ok: false, step: 'P7-merge-not-preserving', m1: m1.ok, m2: m2.ok };
      // P8 delete -> 404 on read (probe cleanup path itself)
      const k = await tracked.put(pfx + 'tmp.json', { t: 1 });
      await b.del(k.url);
      if (await b.status(k.url) !== 404) return { ok: false, step: 'P8-delete-not-effective' };
      return { ok: true };
    })();
  } catch (e) {
    result = { ok: false, step: 'exception', error: String(e && e.message || e) };
  }
  // Cleanup verification: the blob del adapter swallows errors, so confirm absence
  // after every delete. Unconfirmed cleanup fails closed and never masks the
  // original finding (original step/error kept, cleanup flagged).
  let cleanupFailed = false;
  for (const u of urls) {
    try {
      await b.del(u);
      if (await b.status(u) !== 404) cleanupFailed = true; // only a confirmed 404 proves absence
    } catch (e) { cleanupFailed = true; }
  }
  if (cleanupFailed) return { ok: false, step: result.ok ? 'cleanup-failed' : result.step, cleanup: 'failed', error: result.error };
  return result;
}

// --- broadcast helpers (resend() from newsletter/core; injectable for tests) ---
function bc(deps) { return (deps && deps.resend) || require('./core').resend; }
async function listDraftsByName(name, deps) {
  const r = await bc(deps)('/broadcasts?limit=100');
  if (!r.ok) throw new Error('broadcast-list ' + r.status);
  const j = r.json || {};
  if (j.has_more === true || j.hasMore === true) { const e = new Error('broadcast-list-paginated'); e.code = 'broadcast-list-paginated'; throw e; }
  const rows = j.data || j.broadcasts || [];
  return rows.filter((x) => x && x.name === name && x.status === 'draft');
}
// READ-ONLY complete broadcast inventory (recovery review). STRICT pagination AND
// strict response validation, fail closed: every page must be a valid object with
// data:Array and has_more:Boolean, every record needs a unique non-empty string id
// and type-correct fields; any malformed page/record discards the WHOLE result.
// Completion is explicit ({ complete, pages, broadcasts }) - never infer success
// from a top-level ok. Bounded to 10 pages; duplicates/cycles across ALL pages are
// hard errors, never a partial list. Minimal non-PII fields only.
async function listBroadcastInventory(deps) {
  const out = []; const seen = Object.create(null); let after = null;
  const strOrNull = (v) => v === null || v === undefined || typeof v === 'string';
  for (let page = 0; page < 10; page++) {
    const u = '/broadcasts?limit=100' + (after ? '&after=' + encodeURIComponent(after) : '');
    let r;
    try { r = await bc(deps)(u); } catch (e) { throw new Error('broadcast-list transport'); }
    if (!r.ok) throw new Error('broadcast-list ' + r.status);
    const j = r.json;
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('broadcast-list schema');
    if (typeof j.has_more !== 'boolean') throw new Error('broadcast-list schema');
    if (!Array.isArray(j.data)) throw new Error('broadcast-list schema');
    for (const b of j.data) {
      if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !b.id) throw new Error('broadcast-list record-schema');
      if (seen[b.id]) throw new Error('broadcast-list duplicate-id');
      seen[b.id] = true;
      if (!(b.name === null || typeof b.name === 'string') || typeof b.status !== 'string' ||
          !strOrNull(b.created_at) || !strOrNull(b.scheduled_at) || !strOrNull(b.sent_at)) throw new Error('broadcast-list record-schema');
      out.push({ id: b.id, name: b.name == null ? null : b.name, status: b.status, created_at: b.created_at == null ? null : b.created_at, scheduled_at: b.scheduled_at == null ? null : b.scheduled_at, sent_at: b.sent_at == null ? null : b.sent_at });
    }
    if (!j.has_more) return { complete: true, pages: page + 1, broadcasts: out };
    if (!j.data.length) throw new Error('broadcast-list page-empty');
    const next = j.data[j.data.length - 1].id;
    if (next === after) throw new Error('broadcast-list cursor-repeat');
    after = next;
  }
  throw new Error('broadcast-list pages-exceeded');
}
async function getBroadcast(id, deps) {
  const r = await bc(deps)('/broadcasts/' + id);
  if (!r.ok) return null;
  return r.json || null;
}
async function createDraft(cfg, model, html, name, deps) {
  // segment_id AND topic_id are both mandatory here (C2): a broadcast without topic
  // scoping could reach the whole segment - never allowed in this flow.
  if (!deps.segmentIdValue || !deps.topicIdValue) { const e = new Error('audience-unresolved: segmentId and topicId are both required'); e.code = 'audience-unresolved'; throw e; }
  const body = { segment_id: deps.segmentIdValue, topic_id: deps.topicIdValue, from: cfg.from, name, subject: model.subject, html, reply_to: cfg.replyTo || undefined };
  const r = await bc(deps)('/broadcasts', body);
  if (!r.ok) throw new Error('broadcast-create ' + r.status);
  return r.json && r.json.id;
}
async function sendOnce(id, deps) {
  const r = await bc(deps)('/broadcasts/' + id + '/send', {});
  if (!r.ok) { const e = new Error('broadcast-send ' + r.status); e.ambiguous = r.status >= 500; throw e; }
  return r.json;
}

// --- the dispatch state machine ---
// deps: { blob, resend, segmentIdValue, topicIdValue, uuid(), registryKey,
//         registryUrl, eligibleSnapshot, syncAudience }
async function dispatch(cfg, model, html, deps) {
  deps = deps || {};
  if (!deps.segmentIdValue || !deps.topicIdValue) return { ok: false, error: 'audience-unresolved', note: 'segmentId and topicId are both required for every broadcast' };
  const uuid = deps.uuid || crypto.randomUUID;
  const name = cfg.product + ' ' + model.weekLabel; // deterministic per issue
  const issueId = cfg.key + '-' + model.date;
  const me = uuid();
  const now = () => new Date().toISOString();

  const issues0 = await readRegistry(deps);
  if (!issues0) return { ok: false, error: 'registry-missing', note: 'offline provisioning required (scripts/nl-registry-provision.js); no auto-create' };

  // 1) claim via bounded read-merge-CAS. Different issues merge-preserve; the same
  //    issue has exactly one winner. No adoption of foreign claims, ever.
  let rec = null;
  const cur = issues0[issueId];
  if (!cur) {
    const m = await mutateRegistry(deps, (issues) => {
      const c = issues[issueId];
      if (c) { rec = c; return false; } // someone claimed between read and write
      issues[issueId] = { claimant: me, state: 'claimed', name, createdAt: now() };
    });
    if (!m.ok) {
      if (m.error === 'aborted' && rec) return stateOutcome(issueId, rec, deps);
      if (m.error === 'registry-missing') return { ok: false, error: 'registry-missing' };
      return { ok: false, error: 'locked', note: m.error };
    }
    rec = m.issues[issueId];
  } else {
    if (cur.state === 'sent') return { ok: false, error: 'already-sent', broadcastId: cur.broadcastId, sentAt: cur.sentAt };
    if (cur.state === 'sending' || cur.state === 'needs_review') return reconcile(issueId, cur, deps);
    if (cur.state === 'failed-pre') {
      // the one take-overable state: exactly one retrier wins this CAS
      const m = await mutateRegistry(deps, (issues) => {
        const c = issues[issueId];
        if (!c || c.state !== 'failed-pre') { rec = c || null; return false; }
        issues[issueId] = { ...c, claimant: me, state: 'claimed', retriedAt: now(), updatedAt: now() };
      });
      if (!m.ok) return rec ? stateOutcome(issueId, rec, deps) : { ok: false, error: 'locked', note: m.error };
      rec = m.issues[issueId];
    } else {
      // 'claimed'/'draft' owned by someone else: NEVER adopt. The original caller may
      // be live mid-flight. Recovery after a crash is an explicit operator reset
      // routed via main, never automatic. After a reset the orphaned draft is reused
      // by name below.
      return { ok: false, error: 'locked', owner: cur.claimant, ownerState: cur.state, broadcastId: cur.broadcastId };
    }
  }

  // Owner-only transitions: bounded read-merge-CAS that verifies ownership on every
  // write and only ever patches this one issue (other issues merge-preserve).
  const transition = async (patch) => {
    const m = await mutateRegistry(deps, (issues) => {
      const c = issues[issueId];
      if (!c || c.claimant !== me) { rec = c || null; return false; }
      issues[issueId] = { ...c, ...patch, updatedAt: now() };
    });
    if (!m.ok) { if (m.error !== 'aborted') return null; return null; }
    rec = m.issues[issueId];
    return rec;
  };
  const block = async (reason, extra) => { await transition({ state: 'needs_review', reason, ...(extra || {}) }); return { ok: false, error: 'needs_review', reason }; };

  // 2) ensure exactly one provider draft for this issue (drafts cannot send)
  if (rec.state === 'claimed') {
    const existing = await listDraftsByName(name, deps).catch((e) => { if (e.code === 'broadcast-list-paginated') return null; throw e; });
    if (existing === null) return block('broadcast-list-paginated');
    let id = null;
    if (existing.length === 1) id = existing[0].id;
    else if (existing.length > 1) return block('duplicate-drafts', { drafts: existing.map((x) => x.id) });
    else id = await createDraft(cfg, model, html, name, deps).catch(async (e) => {
      if (e.code === 'audience-unresolved') throw e;
      // draft-create failed BEFORE anything can send: mark retryable, not terminal
      await transition({ state: 'failed-pre', reason: 'draft-create: ' + (e && e.message || e) });
      return null;
    });
    if (!id) return { ok: false, error: 'failed-pre', reason: 'draft-create' };
    if (!await transition({ state: 'draft', broadcastId: id, snapshot: deps.eligibleSnapshot })) return { ok: false, error: 'locked' };
  }

  // 2b) audience sync (apply-once; provider preferences win after 'applied').
  // Unresolved sync failures BLOCK the dispatch (needs_review) - the issue is held,
  // never committed with a silently reduced audience.
  if (deps.syncAudience && rec.state === 'draft' && !rec.audienceSync) {
    const sync = await deps.syncAudience().catch((e) => ({ ok: false, error: String(e && e.message || e), failed: ['<exception>'] }));
    if (!await transition({ audienceSync: sync })) return { ok: false, error: 'locked' };
    if (!sync.ok) return block('audience-sync-unresolved', { failed: sync.failed || [] });
  }

  // 3) pre-send provider verification (never send on stale assumptions)
  const bcState = await getBroadcast(rec.broadcastId, deps);
  if (!bcState || bcState.status !== 'draft' || bcState.name !== name) return block('broadcast-not-draft', { provider: bcState && { status: bcState.status, name: bcState.name } });

  // 4) atomic transition into 'sending' BEFORE the one and only send call
  if (!await transition({ state: 'sending' })) return { ok: false, error: 'locked' };
  try {
    await sendOnce(rec.broadcastId, deps);
  } catch (e) {
    // possibly accepted server-side: reconcile status-only, NEVER resend
    const after = await getBroadcast(rec.broadcastId, deps).catch(() => null);
    if (after && after.status === 'sent') { await transition({ state: 'sent', sentAt: after.sent_at || now() }); return { ok: true, reconciled: true, broadcastId: rec.broadcastId }; }
    return block('send-ambiguous', { message: String(e && e.message || e) }); // hard stop
  }
  const sent = await transition({ state: 'sent', sentAt: now() });
  if (!sent) return { ok: false, error: 'locked-after-send', broadcastId: rec.broadcastId, note: 'provider send accepted; registry CAS lost - reconcile manually via GET /broadcasts/' + rec.broadcastId };
  return { ok: true, broadcastId: rec.broadcastId };
}

// Outcome mapping for an existing foreign record: never adopt, never resend.
function stateOutcome(issueId, rec) {
  if (rec.state === 'sent') return { ok: false, error: 'already-sent', broadcastId: rec.broadcastId, sentAt: rec.sentAt };
  if (rec.state === 'needs_review') return { ok: false, error: 'needs_review', reason: rec.reason, broadcastId: rec.broadcastId };
  return { ok: false, error: 'locked', owner: rec.claimant, ownerState: rec.state, broadcastId: rec.broadcastId };
}

// status-only reconcile for 'sending'/'needs_review': never sends, never resends.
// A proven provider 'sent' finalizes the tombstone via CAS; anything else is a hard
// stop for manual review (operator decision routed via main).
async function reconcile(issueId, rec, deps) {
  const after = rec.broadcastId ? await getBroadcast(rec.broadcastId, deps).catch(() => null) : null;
  if (rec.state === 'sending' && after && after.status === 'sent') {
    const m = await mutateRegistry(deps, (issues) => {
      const c = issues[issueId];
      if (!c || c.state !== 'sending') return false;
      issues[issueId] = { ...c, state: 'sent', sentAt: after.sent_at || new Date().toISOString(), reconciled: true };
    });
    if (m.ok) return { ok: true, reconciled: true, broadcastId: rec.broadcastId };
  }
  return { ok: false, error: rec.state === 'needs_review' ? 'needs_review' : 'manual-review-required', reason: rec.reason, broadcastId: rec.broadcastId, providerStatus: after && after.status };
}

// Gate: dispatch is enabled only with an explicit enable flag AND a live-verified
// probe attestation (probeStorage run by the operator against a DISPOSABLE registry).
function dispatchEnabled() {
  return process.env.NL_DISPATCH_ENABLED === '1' && process.env.NL_CAS_VERIFIED === '1';
}

module.exports = { dispatch, probeStorage, dispatchEnabled, provisionRegistry, mutateRegistry, listBroadcastInventory, blob };
