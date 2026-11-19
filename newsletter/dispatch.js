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
// Canonical issue identity: ISO-8601 calendar week of the issue date. Real calendar
// validation included ('2026-13-40' normalizes in Date and is rejected by the
// roundtrip check). Returns 'YYYY-Www' or null for anything invalid.
function isoWeek(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateStr) return null;
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fd = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - fd + 3);
  const week = 1 + Math.round((d - first) / (7 * 864e5));
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
// Real ISO-8601 week validation (2025 has NO W53): week 1..52(+1 only in long years).
const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;
const hasWeek53 = (y) => { const j = new Date(Date.UTC(y, 0, 1)).getUTCDay(); const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; return j === 4 || (leap && j === 3); };
const validIsoWeek = (s) => { const m = ISO_WEEK_RE.exec(typeof s === 'string' ? s : ''); return !!m && +m[2] >= 1 && +m[2] <= 52 + (hasWeek53(+m[1]) ? 1 : 0); };
// Canonical issue keys: '<site>-<YYYY>-W<ww>' with an allowlisted site and a REAL ISO week.
const ISSUE_KEY_RE = /^([a-z0-9]+)-(\d{4}-W\d{2})$/;
// Disposable probe registry targets: nl-probe/<uuid>/registry.json ONLY.
const PROBE_KEY_RE = /^nl-probe\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/registry\.json$/;
const SITES_LIST = () => Object.keys(require('./config').SITES);
const validIssueKey = (k) => { const m = ISSUE_KEY_RE.exec(typeof k === 'string' ? k : ''); return !!m && SITES_LIST().includes(m[1]) && validIsoWeek(m[2]); };
// Strict timestamps: ISO shape AND real calendar date (no 2026-02-30 normalisation).
const STRICT_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const validTs = (s) => {
  if (typeof s !== 'string' || !STRICT_TS_RE.test(s)) return false;
  const [y, mo, d] = s.slice(0, 10).split('-').map(Number);
  const u = new Date(Date.UTC(y, mo - 1, d));
  return u.getUTCFullYear() === y && u.getUTCMonth() === mo - 1 && u.getUTCDate() === d && !isNaN(new Date(s).getTime());
};

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
  // Optional offline seed (deps.seedIssues / deps.seedMeta): pre-assigned issue states
  // (sent tombstones / blocked-legacy from the reviewed recovery inventory), written at
  // creation time only. NEVER used to overwrite an existing registry (inspect-only
  // above). STRICT schema: canonical '<site>-<YYYY>-W<ww>' keys, allowed states only,
  // evidence fields required per state; meta.minIssueWeek is mandatory with a seed and
  // must be a valid ISO week. Anything else refuses BEFORE any write.
  // explicit presence: only a plain object is a seed; null/false/0/''/array refuse
  const hasSeed = deps && Object.prototype.hasOwnProperty.call(deps, 'seedIssues');
  const seed = hasSeed ? deps.seedIssues : null;
  const meta = (deps && deps.seedMeta) || null;
  const STATES = { 'blocked-legacy': ['reason'], 'sent': ['broadcastId', 'sentAt'], 'needs_review': ['reason'], 'locked': ['owner'] };
  if (meta != null && (typeof meta !== 'object' || Array.isArray(meta) || !validIsoWeek(meta.minIssueWeek) || Object.keys(meta).some((k) => k !== 'minIssueWeek'))) throw new Error('provision-seed-invalid: meta.minIssueWeek (real YYYY-Www) required');
  if (hasSeed) {
    if (!seed || typeof seed !== 'object' || Array.isArray(seed)) throw new Error('provision-seed-invalid');
    if (!meta) throw new Error('provision-seed-invalid: meta.minIssueWeek (real YYYY-Www) required');
    for (const [k, v] of Object.entries(seed)) {
      if (!validIssueKey(k)) throw new Error('provision-seed-invalid: bad issue key');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('provision-seed-invalid: bad state object');
      if (!STATES[v.state]) throw new Error('provision-seed-invalid: bad state');
      for (const f of STATES[v.state]) if (typeof v[f] !== 'string' || !v[f]) throw new Error('provision-seed-invalid: missing ' + f);
      if (v.state === 'sent' && !validTs(v.sentAt)) throw new Error('provision-seed-invalid: bad sentAt');
    }
  }
  const init = { v: 1, initializedAt: new Date().toISOString(), ...(meta && validIsoWeek(meta.minIssueWeek) ? { meta: { minIssueWeek: meta.minIssueWeek } } : {}), issues: seed ? { ...seed } : {} };
  // FULL contract validation of the constructed init BEFORE any write: a schema
  // violation means ZERO PUTs, never a persisted broken object. Meta-free
  // creation is allowed ONLY for the internal storage probe, bound to an explicit
  // probe flag AND a random disposable nl-probe/<uuid>/ target - never a regular
  // nl-registry key, and the CLI can never select it. Every other provisioning
  // requires the validated boundary meta (and seed when given) before ANY write.
  const isProbe = deps && deps.probe === true && PROBE_KEY_RE.test(key);
  if (!validateRegistry(init, { canonicalKeys: true, requireMeta: !isProbe })) throw new Error('provision-seed-invalid: production provisioning requires validated seed meta');
  const put = await b.put(key, init);
  // verify durable initialized state before anything may rely on it
  const back = await b.getWithEtag(put.url);
  if (!back || !validateRegistry(back.value, { canonicalKeys: true, requireMeta: !!init.meta })) throw new Error('provision-verify-failed');
  if (seed && JSON.stringify(back.value.issues) !== JSON.stringify(init.issues)) throw new Error('provision-seed-verify-failed');
  if (init.meta && (!back.value.meta || back.value.meta.minIssueWeek !== init.meta.minIssueWeek)) throw new Error('provision-seed-verify-failed');
  return { created: true, url: put.url, registry: back.value };
}

// Bounded read-merge-CAS on the registry. fn(issues) mutates the issues map in place
// and may return false to abort. Retries on 412 with a fresh read (merge-preserving);
// NEVER falls back to a plain write. deps: { blob, registryKey, registryUrl }.
// Strict production validation (meta + canonical keys) is the DEFAULT at every
// mutation read; dispatch additionally pins expectedMinIssueWeek. Only the
// disposable probe namespace may substitute its own validator (deps.validator).
const PROD_VALIDATION = { requireMeta: true, canonicalKeys: true };
async function mutateRegistry(deps, fn, attempts = 4) {
  const b = deps.blob || blob;
  const key = deps.registryKey || REGISTRY_KEY();
  const url = deps.registryUrl || REGISTRY_URL();
  if (!url) return { ok: false, error: 'registry-missing' }; // no auto-create, ever
  const validate = deps.validator || ((reg) => validateRegistry(reg, deps.validatorOpts || PROD_VALIDATION));
  for (let i = 0; i < attempts; i++) {
    const got = await b.getWithEtag(url);
    if (!got) return { ok: false, error: 'registry-missing' }; // fatal: never init online
    if (!validate(got.value)) return { ok: false, error: 'registry-invalid' }; // fail closed, never repair silently
    const reg = got.value;
    const out = await fn(reg.issues);
    if (out === false) return { ok: false, error: 'aborted', issues: reg.issues };
    if (!validate(reg)) return { ok: false, error: 'registry-invalid' }; // never WRITE an invalid registry
    if (await b.putCas(key, reg, got.etag)) return { ok: true, issues: reg.issues, result: out };
  }
  return { ok: false, error: 'cas-contention' };
}
async function readRegistry(deps) {
  const b = deps.blob || blob;
  const url = deps.registryUrl || REGISTRY_URL();
  if (!url) return null;
  const got = await b.getWithEtag(url);
  return got && got.value && got.value.issues ? got.value : null;
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
      const p1 = await provisionRegistry({ blob: tracked, registryKey: regKey, registryUrl: '', probe: true });
      if (!p1.created) return { ok: false, step: 'P1-provision-create-failed' };
      const p2 = await provisionRegistry({ blob: b, registryKey: regKey, registryUrl: p1.url });
      if (p2.created) return { ok: false, step: 'P2-provision-overwrote-existing' };
      // P3 read-after-write + ETag presence on the canonical URL
      const g = await b.getWithEtag(p1.url);
      if (!g || g.value.v !== 1) return { ok: false, step: 'P3-read-after-write-failed' };
      // P4 CAS with current etag succeeds; P5 stale etag -> 412 (false)
      const reg = g.value;
      reg.issues['probe-a'] = { state: 'claimed', claimant: 'probe' };
      if (!await b.putCas(regKey, reg, g.etag)) return { ok: false, step: 'P4-current-cas-failed' };
      if (await b.putCas(regKey, reg, g.etag) !== false) return { ok: false, step: 'P5-stale-cas-not-rejected' };
      // P6 parallel CAS on one etag -> exactly one winner
      const g6 = await b.getWithEtag(p1.url);
      const wins = await Promise.all(Array.from({ length: 6 }, (_, i) => {
        const r6 = JSON.parse(JSON.stringify(g6.value));
        r6.issues['probe-r' + i] = { state: 'claimed', claimant: 'probe' };
        return b.putCas(regKey, r6, g6.etag).catch(() => 'err');
      }));
      if (wins.filter((w) => w === true).length !== 1) return { ok: false, step: 'P6-parallel-cas-not-exclusive', wins: wins.filter((w) => w === true).length };
      // P7 concurrent different-issue claims merge-preserve (both survive)
      // probe CAS runs under the probe-namespace validator ONLY (production
      // validation stays strict and would reject this disposable registry)
      const [m1, m2] = await Promise.all([
        mutateRegistry({ blob: b, registryKey: regKey, registryUrl: p1.url, validator: validateProbeRegistry }, (issues) => { issues['probe-m1'] = { state: 'claimed', claimant: 'probe' }; }),
        mutateRegistry({ blob: b, registryKey: regKey, registryUrl: p1.url, validator: validateProbeRegistry }, (issues) => { issues['probe-m2'] = { state: 'claimed', claimant: 'probe' }; })
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

// Unified strict registry validation, used by dispatch AND every CAS read. No silent
// normalisation anywhere: v must be 1, issues a plain object, every entry a plain
// object with a known state and that state's required evidence fields. Options:
// requireMeta (valid meta.minIssueWeek) and canonicalKeys (allowlisted site + real
// ISO week per issue key).
// Unified strict registry validation, applied by the dispatch read AND every CAS
// read AND every CAS write (pre-PUT re-validation). No silent normalisation
// anywhere. Contract:
// - top level: plain object, keys only within {v, initializedAt, meta, issues};
//   v === 1; initializedAt a strict real-calendar ISO timestamp; issues a plain object.
// - meta (mandatory under requireMeta): plain object, EXACTLY { minIssueWeek: real
//   ISO week } - unknown/extra meta keys or a wrong type fail. expectedMinIssueWeek
//   PINS the boundary for a running dispatch: any change/raise/loss of the boundary
//   between reads fails validation and locks that dispatch before claim/create/send.
// - issue entries: plain objects, known state, per-state required evidence fields,
//   whitelisted keys only, strict real-calendar timestamps, coherent provenance
//   triple (claimant/name/createdAt: all three or none). Run states
//   (claimed/draft/sending/failed-pre) REQUIRE provenance; the seed states the
//   offline provisioner may write (blocked-legacy, locked, and provenance-free
//   sent/needs_review tombstones) are never sufficient for a run takeover.
const TS_KEYS = { createdAt: 1, updatedAt: 1, sentAt: 1, retriedAt: 1 };
const OBJ_KEYS = { snapshot: 1, audienceSync: 1, detail: 1 };
const PROV_KEYS = ['claimant', 'name', 'createdAt'];
const STATE_FIELDS = {
  claimed:          { req: ['claimant', 'name', 'createdAt'], opt: ['updatedAt', 'retriedAt', 'broadcastId'] },
  draft:            { req: ['claimant', 'name', 'createdAt', 'broadcastId'], opt: ['updatedAt', 'retriedAt', 'snapshot', 'audienceSync'] },
  sending:          { req: ['claimant', 'name', 'createdAt', 'broadcastId'], opt: ['updatedAt', 'retriedAt', 'snapshot', 'audienceSync'] },
  sent:             { req: ['broadcastId', 'sentAt'], opt: ['claimant', 'name', 'createdAt', 'updatedAt', 'retriedAt', 'snapshot', 'audienceSync', 'reconciled'] },
  'failed-pre':     { req: ['claimant', 'name', 'createdAt', 'reason'], opt: ['updatedAt', 'retriedAt', 'broadcastId', 'snapshot'] },
  needs_review:     { req: ['reason'], opt: ['claimant', 'name', 'createdAt', 'updatedAt', 'retriedAt', 'broadcastId', 'snapshot', 'audienceSync', 'detail'] },
  'blocked-legacy': { req: ['reason'], opt: ['detail'] },
  locked:           { req: ['owner'], opt: ['reason', 'createdAt', 'detail'] }
};
function validateEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const spec = STATE_FIELDS[v.state];
  if (!spec) return false;
  const allowed = new Set(['state', ...spec.req, ...spec.opt]);
  for (const k of Object.keys(v)) { if (v[k] === undefined) continue; if (!allowed.has(k)) return false; }
  for (const f of spec.req) { if (typeof v[f] !== 'string' || !v[f]) return false; }
  // coherent provenance: claimant/name/createdAt all-or-none
  const prov = PROV_KEYS.filter((k) => v[k] !== undefined);
  if (prov.length && prov.length !== PROV_KEYS.length) return false;
  for (const k of Object.keys(v)) {
    const val = v[k];
    if (val === undefined || k === 'state') continue;
    if (TS_KEYS[k]) { if (!validTs(val)) return false; }
    else if (OBJ_KEYS[k]) { if (!val || typeof val !== 'object' || Array.isArray(val)) return false; }
    else if (k === 'reconciled') { if (val !== true) return false; }
    else if (typeof val !== 'string' || !val) return false;
  }
  return true;
}
function validateMeta(meta, opts) {
  if (meta == null) return !(opts && opts.requireMeta);
  if (typeof meta !== 'object' || Array.isArray(meta)) return false;
  const ks = Object.keys(meta);
  if (ks.length !== 1 || ks[0] !== 'minIssueWeek' || !validIsoWeek(meta.minIssueWeek)) return false;
  if (opts && opts.expectedMinIssueWeek && meta.minIssueWeek !== opts.expectedMinIssueWeek) return false;
  return true;
}
function validateRegistry(reg, opts) {
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return false;
  for (const k of Object.keys(reg)) if (!['v', 'initializedAt', 'meta', 'issues'].includes(k)) return false;
  if (reg.v !== 1) return false;
  if (!validTs(reg.initializedAt)) return false;
  if (!reg.issues || typeof reg.issues !== 'object' || Array.isArray(reg.issues)) return false;
  if (!validateMeta(reg.meta, opts)) return false;
  for (const [k, v] of Object.entries(reg.issues)) {
    if (opts && opts.canonicalKeys && !validIssueKey(k)) return false;
    if (!validateEntry(v)) return false;
  }
  return true;
}
// Probe-namespace validation: the ONLY validator the disposable nl-probe registry
// may use. Probe entries live exclusively under 'probe-*' keys in one fixed shape;
// the production validator never accepts them (canonical keys) and the probe
// validator never accepts production entries or field-grown probes - production
// validation is NEVER loosened to rescue a probe.
function validateProbeRegistry(reg) {
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return false;
  for (const k of Object.keys(reg)) if (!['v', 'initializedAt', 'meta', 'issues'].includes(k)) return false;
  if (reg.v !== 1 || !validTs(reg.initializedAt)) return false;
  if (!reg.issues || typeof reg.issues !== 'object' || Array.isArray(reg.issues)) return false;
  for (const [k, v] of Object.entries(reg.issues)) {
    if (!/^probe-[a-z0-9-]+$/.test(k)) return false;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const ks = Object.keys(v).sort();
    if (ks.join(',') !== 'claimant,state' || v.state !== 'claimed' || v.claimant !== 'probe') return false;
  }
  return true;
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
  const name = cfg.product + ' ' + model.weekLabel; // display only - identity is the ISO week below
  // Canonical atomic issue identity: site + ISO calendar week of the issue date.
  // weekLabel/date strings never alter identity; two dates of one week share ONE
  // claim. Invalid calendar dates refuse BEFORE any registry/provider access.
  const wk = isoWeek(model.date);
  if (!wk) return { ok: false, error: 'blocked-legacy', reason: 'invalid-issue-date' };
  const issueId = cfg.key + '-' + wk;
  const me = uuid();
  const now = () => new Date().toISOString();

  const reg0 = await readRegistry(deps);
  if (!reg0) return { ok: false, error: 'registry-missing', note: 'offline provisioning required (scripts/nl-registry-provision.js); no auto-create' };
  const issues0 = reg0.issues;
  // The WHOLE loaded registry must satisfy the unified strict schema (v, plain issues
  // object, canonical allowlisted keys, per-state evidence fields) BEFORE anything is
  // claimed or any provider is touched. Damaged registries fail closed, never repair.
  if (!validateRegistry(reg0, { canonicalKeys: true })) return { ok: false, error: 'registry-invalid' };
  // Durable lower bound, FAIL CLOSED: the seeded registry must carry a valid
  // meta.minIssueWeek; missing/invalid meta blocks every issue (no env fallback).
  // Issue weeks before the bound are never claimable - including days of an
  // unreviewed legacy week after a mid-week cutoff, and unenumerated old keys.
  const minWeek = reg0.meta && validIsoWeek(reg0.meta.minIssueWeek) ? reg0.meta.minIssueWeek : null;
  if (!minWeek) return { ok: false, error: 'blocked-legacy', reason: 'min-issue-week-missing' };
  if (wk < minWeek) return { ok: false, error: 'blocked-legacy', reason: 'before-min-issue-week', minIssueWeek: minWeek };
  // Every mutation read below re-validates the WHOLE registry against the FULL
  // production contract with the boundary PINNED to the value read here: a
  // changed/raised/lost minIssueWeek (or any other schema break) BETWEEN reads
  // fails validation and locks THIS dispatch before any claim/create/send.
  const mdeps = { ...deps, validatorOpts: { requireMeta: true, canonicalKeys: true, expectedMinIssueWeek: minWeek } };

  // 1) claim via bounded read-merge-CAS. Different issues merge-preserve; the same
  //    issue has exactly one winner. No adoption of foreign claims, ever.
  let rec = null;
  const cur = issues0[issueId];
  if (!cur) {
    const m = await mutateRegistry(mdeps, (issues) => {
      const c = issues[issueId];
      if (c) { rec = c; return false; } // someone claimed between read and write
      issues[issueId] = { claimant: me, state: 'claimed', name, createdAt: now() };
    });
    if (!m.ok) {
      if (m.error === 'aborted' && rec) return stateOutcome(issueId, rec, deps);
      if (m.error === 'registry-missing') return { ok: false, error: 'registry-missing' };
      if (m.error === 'registry-invalid') return { ok: false, error: 'registry-invalid' };
      return { ok: false, error: 'locked', note: m.error };
    }
    rec = m.issues[issueId];
  } else {
    if (cur.state === 'sent') return { ok: false, error: 'already-sent', broadcastId: cur.broadcastId, sentAt: cur.sentAt };
    if (cur.state === 'blocked-legacy') return { ok: false, error: 'blocked-legacy', reason: cur.reason || 'seeded' };
    if (cur.state === 'sending' || cur.state === 'needs_review') return reconcile(issueId, cur, mdeps);
    if (cur.state === 'failed-pre') {
      // the one take-overable state: exactly one retrier wins this CAS. A fresh,
      // schema-clean claimed entry is written (provenance kept, run binding kept,
      // terminal reason dropped) - never a field-accumulating spread.
      const m = await mutateRegistry(mdeps, (issues) => {
        const c = issues[issueId];
        if (!c || c.state !== 'failed-pre') { rec = c || null; return false; }
        issues[issueId] = { claimant: me, state: 'claimed', name: c.name, createdAt: c.createdAt, retriedAt: now(), updatedAt: now(), ...(c.broadcastId ? { broadcastId: c.broadcastId } : {}) };
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
    const m = await mutateRegistry(mdeps, (issues) => {
      const c = issues[issueId];
      if (!c || c.claimant !== me) { rec = c || null; return false; }
      issues[issueId] = { ...c, ...patch, updatedAt: now() };
    });
    if (!m.ok) { if (m.error !== 'aborted') return null; return null; }
    rec = m.issues[issueId];
    return rec;
  };
  const block = async (reason, extra) => { await transition({ state: 'needs_review', reason, ...(extra ? { detail: extra } : {}) }); return { ok: false, error: 'needs_review', reason }; };

  // 2) ensure exactly one provider draft for this issue (drafts cannot send)
  if (rec.state === 'claimed') {
    // Full read-only inventory first: a sent/scheduled/queued broadcast with this
    // issue's name ALWAYS hard-blocks (needs_review), never just drafts.
    const inv = await listBroadcastInventory(deps).catch(() => null);
    if (!inv || !inv.complete) return block('broadcast-list-unreadable');
    const nonDraft = inv.broadcasts.filter((x) => x.name === name && x.status !== 'draft');
    if (nonDraft.length) return block('broadcast-exists-non-draft', { broadcasts: nonDraft.map((x) => ({ id: x.id, status: x.status })) });
    const drafts = inv.broadcasts.filter((x) => x.name === name && x.status === 'draft');
    let id = null;
    if (rec.broadcastId) {
      // retry with an existing registry binding: ONLY the bound draft may continue,
      // and it must pass the FULL content check at step 3 before any send.
      const bound = drafts.find((x) => x.id === rec.broadcastId);
      if (!bound) return block('bound-draft-missing', { broadcastId: rec.broadcastId });
      if (drafts.length > 1) return block('duplicate-drafts', { drafts: drafts.map((x) => x.id) });
      id = rec.broadcastId;
    } else {
      // Fresh claim: ANY pre-existing draft with this issue's name is foreign and
      // stays blocked (needs_review). Ownership binds strictly via broadcastId.
      if (drafts.length) return block('draft-exists-unowned', { drafts: drafts.map((x) => x.id) });
      id = await createDraft(cfg, model, html, name, deps).catch(async (e) => {
        if (e.code === 'audience-unresolved') throw e;
        // draft-create failed BEFORE anything can send: mark retryable, not terminal
        await transition({ state: 'failed-pre', reason: 'draft-create: ' + (e && e.message || e) });
        return null;
      });
      if (!id) return { ok: false, error: 'failed-pre', reason: 'draft-create' };
    }
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

  // 3) pre-send provider verification, FULL binding (never send on stale or foreign
  // content): status draft + name + subject + html + from + reply_to + segment_id +
  // topic_id must ALL match this exact issue render and audience.
  const bcState = await getBroadcast(rec.broadcastId, deps);
  const normReply = (v) => (Array.isArray(v) ? v.slice() : (v ? [v] : []));
  const wantReply = normReply(cfg.replyTo);
  const gotReply = bcState ? normReply(bcState.reply_to) : null;
  const replyMatch = !!gotReply && gotReply.length === wantReply.length && gotReply.every((x, i) => x === wantReply[i]);
  const contentBound = bcState && bcState.status === 'draft' && bcState.name === name &&
    bcState.subject === model.subject && bcState.html === html && bcState.from === cfg.from &&
    replyMatch &&
    bcState.segment_id === deps.segmentIdValue && bcState.topic_id === deps.topicIdValue;
  if (!contentBound) return block('broadcast-not-draft', { provider: bcState && { status: bcState.status, name: bcState.name } });

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

module.exports = { dispatch, probeStorage, dispatchEnabled, provisionRegistry, mutateRegistry, readRegistry, listBroadcastInventory, isoWeek, validateRegistry, validateProbeRegistry, blob };
