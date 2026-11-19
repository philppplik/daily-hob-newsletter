'use strict';
// Lead-Wall backend helpers. No npm dependencies: Node fetch + crypto only.
const crypto = require('crypto');
const TK_TEXT_VERSION = 'tk-2026-10-24-v4'; // Einwilligungstext Toolkit-Download v3: + Wochenrueckblick am Sonntag (24.10.2026)
const ATLAS_TEXT_VERSION = 'atlas-2026-10-23-v2'; // Einwilligungstext Modell-Atlas-Datenpaket
const ATLAS_VERSION = '1.0';
const TK_VERSION = '1.0';
const TEXT_VERSION = 'lw-2026-10-24-v4'; // Einwilligungstext Baustein 6.1 v3: + Wochenrueckblick am Sonntag (24.10.2026)
const SITE = process.env.SITE_URL || 'https://kifachblatt.de';
const SITE_IW = process.env.IW_SITE_URL || 'https://intelligenz-welt.de';
const SITE_FA = process.env.FA_SITE_URL || 'https://finanz-adjust.de';
const API = process.env.API_URL || '';
// Link-Builder fuer oeffentliche Routen: funktioniert mit API_URL als Bare-Host
// ('https://x.vercel.app'), mit Legacy-Form mit Trailing-/lw ('https://x.vercel.app/lw',
// Produktion seit 20.10.) und mit/ohne trailing slash - immer genau ein '/lw' im Pfad.
// Liest die Env bei jedem Aufruf (kein Modul-Cache, testbar).
const apiUrl = (path) => {
  const base = String(process.env.API_URL || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  return base + (base.endsWith('/lw') && p.startsWith('/lw/') ? p.slice(3) : p);
};
const FROM = process.env.MAIL_FROM || 'KI Fachblatt <briefing@hob.philipp-paulik.de>';
const REPLY = process.env.MAIL_REPLY_TO || 'redaktion@kifachblatt.de';

const b64 = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const key = () => { const k = process.env.LW_SECRET; if (!k || k.length < 24) throw new Error('LW_SECRET missing'); return k; };
const sign = (msg) => crypto.createHmac('sha256', key()).update(msg).digest('base64url');
// Admin auth (x-lw-auth on ops endpoints like nlweekly): accepts an HMAC under
// LW_SECRET and, additionally, under NL_ADMIN_KEY when set (>=24 chars). Additive on
// purpose: user-facing tokens (doi/dl/unsub) stay signed by LW_SECRET alone, so a
// lost operator key never forces a rotation that would break live links. A too-short
// NL_ADMIN_KEY is ignored, never an error path that weakens the check.
const adminOk = (gotHeader, msg) => {
  const got = Buffer.from(String(gotHeader || ''));
  const keys = [process.env.LW_SECRET, process.env.NL_ADMIN_KEY].filter((k) => k && k.length >= 24);
  if (!keys.length) throw new Error('admin key missing');
  return keys.some((k) => {
    const want = Buffer.from(crypto.createHmac('sha256', k).update(msg).digest('base64url'));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
};
const norm = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => e.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(e);
const idOf = (email) => sha(norm(email)).slice(0, 40);

// Tokens carry only the id hash, never the address. purpose separates DOI / download / unsubscribe.
function token(purpose, id, ttlSec) {
  const exp = ttlSec ? Math.floor(Date.now() / 1000) + ttlSec : 0;
  const body = [purpose, id, exp].join('.');
  return b64(body) + '.' + sign(body);
}
function verify(purpose, tok) {
  try {
    const [p, s] = String(tok).split('.');
    const body = Buffer.from(p, 'base64url').toString();
    const a = Buffer.from(s || ''); const b = Buffer.from(sign(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const [pur, id, exp] = body.split('.');
    if (pur !== purpose) return null;
    if (Number(exp) && Number(exp) < Date.now() / 1000) return null;
    return id;
  } catch (e) { return null; }
}

// Store: Vercel Blob REST (private-ish, unguessable path) or in-memory for tests.
// Prefix separates consent records per site/purpose (optin/ = KIFB, optin-iw/ = Intelligenz Welt) - never shared.
const mem = new Map(); const memEtag = new Map();
// Private Blob store: reads and writes both need the read-write token (Authorization: Bearer).
const blobHost = () => {
  const id = String(process.env.BLOB_STORE_ID || String(process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[3] || '').replace(/^store_/, '').toLowerCase();
  return 'https://' + id + '.private.blob.vercel-storage.com';
};
const blobAuth = () => ({ authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN, 'x-api-version': '7' });
const storeFor = (prefix) => ({
  // All stored opt-in records under this prefix: [{ id, rec }]. Used for weekly-newsletter
  // eligibility from our own consent records instead of Resend segments (Marketing plan
  // segment limits; a segment membership alone must never imply weekly consent).
  async list() {
    if (process.env.LW_STORE === 'memory') {
      const out = [];
      for (const [k, rec] of mem.entries()) if (k.startsWith(prefix)) out.push({ id: k.slice(prefix.length), rec });
      return out;
    }
    const out = []; let cursor = null, pages = 0;
    do {
      const u = 'https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(prefix) + '&limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await fetch(u, { headers: blobAuth() });
      if (!r.ok) throw new Error('blob-list ' + r.status);
      const j = await r.json();
      for (const b of j.blobs || []) {
        const pn = b.pathname || '';
        if (!pn.startsWith(prefix) || !pn.endsWith('.json')) continue;
        const id = pn.slice(prefix.length, -5);
        out.push({ id, rec: await this.get(id) });
      }
      cursor = j.hasMore ? j.cursor : null; pages++;
    } while (cursor && pages < 20);
    return out;
  },
  async get(id) {
    if (process.env.LW_STORE === 'memory') { const v = mem.get(prefix + id); return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
    const r = await fetch(blobHost() + '/' + prefix + id + '.json?cache=0', { headers: blobAuth() });
    return r.ok ? r.json() : null;
  },
  // ETag-carrying read + compare-and-swap write (atomic per-record claims, e.g. the
  // audience-sync attempting-marker). Missing ETag hard-fails like newsletter/dispatch.
  async getWithEtag(id) {
    if (process.env.LW_STORE === 'memory') { const v = mem.get(prefix + id); return v === undefined ? null : { value: JSON.parse(JSON.stringify(v)), etag: 'mem-' + (memEtag.get(prefix + id) || 0) }; }
    const r = await fetch(blobHost() + '/' + prefix + id + '.json?cache=0', { headers: blobAuth() });
    if (!r.ok) return null;
    const etag = r.headers.get('etag');
    if (!etag) throw new Error('blob-etag-missing');
    return { value: await r.json(), etag };
  },
  // Bounded read-merge-CAS: fn(rec) mutates a fresh read; the write only lands via CAS.
  // A 412 retries with a fresh read (bounded); it NEVER falls back to a plain put, so a
  // concurrent consent/unsubscribe field on the same record can never be clobbered.
  async mutateCas(id, fn, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      const got = await this.getWithEtag(id);
      if (!got) return { ok: false, error: 'record-missing' };
      const rec = got.value;
      const out = await fn(rec);
      if (out === false) return { ok: false, error: 'aborted', rec };
      const okCas = await this.putCas(id, rec, got.etag);
      if (okCas) return { ok: true, rec };
    }
    return { ok: false, error: 'cas-contention' };
  },
  async putCas(id, rec, etag) {
    if (!etag) throw new Error('blob-etag-missing');
    if (process.env.LW_STORE === 'memory') {
      const cur = memEtag.get(prefix + id) || 0;
      if (('mem-' + cur) !== etag) return false;
      mem.set(prefix + id, JSON.parse(JSON.stringify(rec))); memEtag.set(prefix + id, cur + 1); return true;
    }
    const r = await fetch('https://blob.vercel-storage.com/' + prefix + id + '.json', {
      method: 'PUT',
      headers: { ...blobAuth(), 'x-api-version': '7', 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-if-match': etag, 'x-content-type': 'application/json' },
      body: JSON.stringify(rec)
    });
    if (r.status === 412) return false;
    if (!r.ok) throw new Error('store putCas ' + r.status);
    return true;
  },
  async put(id, rec) {
    if (process.env.LW_STORE === 'memory') { mem.set(prefix + id, JSON.parse(JSON.stringify(rec))); memEtag.set(prefix + id, (memEtag.get(prefix + id) || 0) + 1); return; }
    const r = await fetch('https://blob.vercel-storage.com/' + prefix + id + '.json', {
      method: 'PUT',
      headers: { ...blobAuth(), 'x-api-version': '7', 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-content-type': 'application/json' },
      body: JSON.stringify(rec)
    });
    if (!r.ok) throw new Error('store put ' + r.status);
  }
});
const store = storeFor('optin/');

// from/replyTo optional per purpose (IW uses its own display name on the same verified sender domain);
// replyTo === null omits the header instead of defaulting to the KIFB address.
async function sendMail({ to, subject, html, text, headers, from, replyTo }) {
  if (process.env.LW_MAIL === 'dry') { sendMail.last = { to, subject, html, text, headers, from, replyTo }; return { id: 'dry' }; }
  const body = { from: from || FROM, to: [to], subject, html, text, headers };
  if (replyTo !== null) body.reply_to = replyTo || REPLY;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('resend ' + r.status);
  return r.json();
}

function cors(req, res) {
  const o = req.headers.origin;
  if (o === SITE || o === SITE.replace('://', '://www.') || o === SITE_IW || o === SITE_IW.replace('://', '://www.') || o === SITE_FA || o === SITE_FA.replace('://', '://www.')) res.setHeader('access-control-allow-origin', o);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  return false;
}
const json = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); };
const redirect = (res, url) => { res.statusCode = 303; res.setHeader('location', url); res.setHeader('cache-control', 'no-store'); res.end(); };
const ip = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
const readBody = async (req) => { if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; let d = ''; for await (const c of req) d += c; return d ? JSON.parse(d) : {}; };

// Report PDFs live in Vercel Blob under an unguessable, deterministic path (date + HMAC). Never linked publicly;
// /api/pdf streams them after the subscriber token check, so the Blob URL is not exposed.
const reportPath = (date) => 'reports/ki-tagesbericht-' + date + '-' + sign('report:' + date).slice(0, 24) + '.pdf';
async function fetchReport(date) {
  if (process.env.LW_STORE === 'memory') return (global.__reports || {})[date] || null;
  const r = await fetch(blobHost() + '/' + reportPath(date) + '?cache=0', { headers: blobAuth() });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
async function latestReport() {
  // Ausgabedatum ist Europe/Berlin (Dateiname), nicht UTC: um 00-02 Uhr MESZ weichen beide ab.
  const berlin = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const days = [berlin];
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    if (!days.includes(d)) days.push(d);
  }
  for (const d of days) { const b = await fetchReport(d); if (b) return { date: d, buf: b }; }
  return null;
}
// Toolkit ZIP: private Blob, unguessable path (version + HMAC), streamed only after the subscriber check.
const toolkitPath = (v) => 'toolkit/kifb-eu-ki-toolkit-v' + v + '-' + sign('toolkit:' + v).slice(0, 24) + '.zip';
async function fetchToolkit(v) {
  if (process.env.LW_STORE === 'memory') return (global.__toolkit || {})[v] || null;
  const r = await fetch(blobHost() + '/' + toolkitPath(v) + '?cache=0', { headers: blobAuth() });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
// Atlas data package (ZIP: radar PDF + CSV + JSON): private Blob, unguessable path (version + HMAC),
// streamed only after the subscriber check. Upload via /api/atlasupload (HMAC), never linked publicly.
const atlasPath = (v) => 'atlas/modell-atlas-datenpaket-v' + v + '-' + sign('atlas:' + v).slice(0, 24) + '.zip';
async function fetchAtlas(v) {
  if (process.env.LW_STORE === 'memory') return (global.__atlas || {})[v] || null;
  const r = await fetch(blobHost() + '/' + atlasPath(v) + '?cache=0', { headers: blobAuth() });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
// KIFB list lives in its own Resend segment (never the Daily Hob one).
// Weekly-newsletter topic per site: NULL while the audience design PENDS user approval
// (topics/segments) is decided - pending user approval, nothing activated.
// Weekly sync targets a private Resend TOPIC (explicit opt-in), never a segment:
// no new segment is ever created implicitly (Free plan: 3/3 in use).
const weeklyTopic = (site) => process.env['NL_TOPIC_ID_' + String(site || '').toUpperCase()] || null;
// Ensure the contact exists WITHOUT touching its global unsubscribe state: a fresh
// weekly topic opt-in is NOT a blanket global resubscribe. We therefore never send
// `unsubscribed:false` on upsert; a globally opted-out contact keeps its opt-out
// (provider skips it on broadcasts) unless a fresh appropriate consent covers re-entry.
async function ensureContact(email) {
  if (process.env.LW_MAIL === 'dry') { (ensureContact.calls = ensureContact.calls || []).push(email); return 'dry'; }
  const h = { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' };
  const g = await fetch('https://api.resend.com/contacts/' + encodeURIComponent(email), { headers: h });
  if (g.ok) return 'existing';
  if (g.status !== 404) throw new Error('contact-read ' + g.status);
  const c = await fetch('https://api.resend.com/contacts', { method: 'POST', headers: h, body: JSON.stringify({ email }) }); // no unsubscribed field: provider default, never a resubscribe
  if (!c.ok && c.status !== 409) throw new Error('contact-create ' + c.status);
  return 'created';
}
// PATCH /contacts/{email}/topics (update-contact-topics): subscription 'opt_in' | 'opt_out'.
// Contact is ensured first, so the PATCH never 404s on a new subscriber (R1).
async function topicSubscribe(email, topicId, subscription) {
  if (process.env.LW_MAIL === 'dry') { (topicSubscribe.calls = topicSubscribe.calls || []).push({ email, topicId, subscription }); return; }
  await ensureContact(email);
  const r = await fetch('https://api.resend.com/contacts/' + encodeURIComponent(email) + '/topics', {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ topics: [{ id: topicId, subscription }] })
  });
  if (!r.ok) throw new Error('topic-subscribe ' + r.status);
}
// Explicit join into an EXISTING segment by id (R2): never creates segments, never
// touches unsubscribed. Gated everywhere on the pending-approval env ids.
async function segmentJoin(email, segId) {
  if (process.env.LW_MAIL === 'dry') { (segmentJoin.calls = segmentJoin.calls || []).push({ email, segId }); return; }
  await ensureContact(email);
  const h = { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' };
  const r = await fetch('https://api.resend.com/contacts/' + encodeURIComponent(email) + '/segments/' + segId, { method: 'POST', headers: h });
  if (!r.ok) throw new Error('segment-join ' + r.status);
}
const weeklySegmentId = (site) => process.env['NL_SEGMENT_ID_' + String(site || '').toUpperCase()] || null;
// KIFB segment found by name, created once.
const segCache = {};
async function segmentId(name = 'KI Fachblatt Tagesbericht') {
  if (segCache[name]) return segCache[name];
  const h = { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' };
  let r = await fetch('https://api.resend.com/segments', { headers: h });
  if (r.ok) { const j = await r.json(); const hit = (j.data || []).find((x) => x.name === name); if (hit) return (segCache[name] = hit.id); }
  r = await fetch('https://api.resend.com/segments', { method: 'POST', headers: h, body: JSON.stringify({ name }) });
  if (!r.ok) throw new Error('segment ' + r.status);
  return (segCache[name] = (await r.json()).id);
}
async function addToSegment(email, name) {
  if (process.env.LW_MAIL === 'dry') return;
  const h = { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' };
  const id = await segmentId(name);
  let r = await fetch('https://api.resend.com/contacts', { method: 'POST', headers: h, body: JSON.stringify({ email, unsubscribed: false, segments: [{ id }] }) });
  if (!r.ok) await fetch('https://api.resend.com/contacts/' + encodeURIComponent(email) + '/segments/' + id, { method: 'POST', headers: h });
}
module.exports = { storeFor, apiUrl, weeklyTopic, weeklySegmentId, topicSubscribe, segmentJoin, ensureContact, SITE_IW, SITE_FA, segmentId, ATLAS_TEXT_VERSION, ATLAS_VERSION, atlasPath, fetchAtlas, TK_TEXT_VERSION, TK_VERSION, toolkitPath, fetchToolkit, sign, adminOk, reportPath, fetchReport, latestReport, addToSegment, TEXT_VERSION, SITE, API, idOf, norm, validEmail, token, verify, store, sendMail, cors, json, redirect, ip, readBody };
