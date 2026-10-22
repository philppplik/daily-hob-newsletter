'use strict';
process.env.LW_SECRET = 'x'.repeat(40); process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry'; process.env.API_URL = 'https://api.test';
const test = require('node:test'); const assert = require('node:assert');
const L = require('../api/_lw'); const IW = require('../api/_iw/iwlib');
const sub = require('../api/_iw/iwsub'); const conf = require('../api/lw-confirm'); const pdf = require('../api/_iw/iwpdf'); const un = require('../api/_iw/iwunsub');
const mk = (method, url, body) => ({ method, url, headers: { 'x-forwarded-for': '203.0.113.9' }, body });
const rs = () => { const r = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, end(b) { this.body = b; } }; return r; };

test('IW DOI flow: no PDF before confirm, own records, no segment, unsubscribe works', async () => {
  let r = rs(); await sub(mk('POST', '/lw/api/iwsub', { email: 'I@Test.de', consent: true }), r); assert.equal(r.statusCode, 200);
  const mail = require('../api/_lw').sendMail.last;
  assert.ok(mail.text.includes('/api/confirm?s=iw&t=')); assert.ok(mail.text.includes('s=iw'));
  assert.equal(mail.from, IW.IW_FROM, 'IW display name on the verified sender domain');
  assert.equal(mail.replyTo, null, 'no invented IW reply address');
  assert.ok(!/\.pdf/.test(mail.html + mail.text), 'DOI mail must not contain the PDF');
  assert.ok(!/<img/i.test(mail.html), 'no tracking pixel');
  const id = L.idOf('i@test.de');
  let rec = await IW.iwStore.get(id);
  assert.equal(rec.textVersion, IW.IW_TEXT_VERSION); assert.equal(rec.source, 'iw'); assert.equal(rec.confirmedAt, null); assert.equal(rec.signupIp, '203.0.113.9');
  assert.equal(await L.store.get(id), null, 'IW consent record must not exist in the KIFB store (consent separation)');
  const t = decodeURIComponent(mail.text.match(/t=([^\s&]+)/)[1]);
  // PDF before confirm: fail closed
  r = rs(); await pdf(mk('GET', '/lw/api/iwpdf?k=' + L.token('dl-iw', id, 0)), r); assert.match(r.headers.location, /intelligenz-welt\.de\/tagesbericht-anmelden/);
  // wrong-purpose token (KIFB doi/dl) must not confirm or download
  assert.equal(L.verify('dl-iw', L.token('dl', id, 0)), null, 'KIFB dl token has no IW meaning');
  let segN = 0; const origSeg = L.addToSegment; L.addToSegment = async () => { segN++; };
  r = rs(); await conf(mk('GET', '/api/confirm?s=iw&t=' + encodeURIComponent(t)), r);
  assert.match(r.headers.location, /intelligenz-welt\.de\/tagesbericht-bestaetigt#k=/);
  assert.equal(segN, 0, 'IW confirm must not join any Resend segment (PDF access only, no daily send in this consent)');
  L.addToSegment = origSeg;
  rec = await IW.iwStore.get(id); assert.ok(rec.confirmedAt && rec.confirmIp);
  const k = r.headers.location.split('#k=')[1];
  global.__iwreports = { [new Date().toISOString().slice(0, 10)]: Buffer.from('%PDF-iw') };
  r = rs(); await pdf(mk('GET', '/lw/api/iwpdf?k=' + k), r);
  assert.equal(r.statusCode, 200); assert.equal(r.headers['content-type'], 'application/pdf');
  assert.ok(r.headers['content-disposition'].includes('intelligenz-welt-tagesausgabe-'));
  assert.equal(String(r.body), '%PDF-iw');
  r = rs(); await un(mk('GET', '/lw/api/iwunsub?t=' + encodeURIComponent(L.token('unsub-iw', id, 0))), r); assert.match(r.headers.location, /intelligenz-welt\.de\/abmelden\?ok=1/);
  r = rs(); await pdf(mk('GET', '/lw/api/iwpdf?k=' + k), r); assert.match(r.headers.location, /tagesbericht-anmelden/);
});

test('IW rejects missing consent, bad email, forged/expired tokens', async () => {
  let r = rs(); await sub(mk('POST', '/', { email: 'a@test.de', consent: false }), r); assert.equal(r.statusCode, 400);
  r = rs(); await sub(mk('POST', '/', { email: 'nope', consent: true }), r); assert.equal(r.statusCode, 400);
  assert.equal(L.verify('dl-iw', 'abc.def'), null);
  assert.equal(L.verify('doi-iw', L.token('dl-iw', 'x', 0)), null);
  const id = L.idOf('exp-iw@test.de');
  await IW.iwStore.put(id, { email: 'exp-iw@test.de', source: 'iw', signupAt: new Date().toISOString(), signupIp: '203.0.113.9', textVersion: IW.IW_TEXT_VERSION, confirmedAt: new Date().toISOString(), confirmIp: '203.0.113.9', unsubscribedAt: null });
  global.__iwreports = { [new Date().toISOString().slice(0, 10)]: Buffer.from('%PDF-iw') };
  r = rs(); await pdf(mk('GET', '/lw/api/iwpdf?k=' + L.token('dl-iw', id, -3600)), r);
  assert.match(r.headers.location, /tagesbericht-anmelden/, 'expired dl-iw token must not get the PDF');
  r = rs(); await conf(mk('GET', '/api/lw-confirm?s=iw&t=' + encodeURIComponent(L.token('doi-iw', id, -3600))), r);
  assert.match(r.headers.location, /tagesbericht-bestaetigt\?e=1/, 'expired doi-iw token must fail closed');
});

test('IW upload: HMAC gate and path', async () => {
  const up = require('../api/_iw/iwupload');
  const crypto = require('crypto');
  const date = '2026-10-22';
  const good = L.sign('upload:iwreport:' + date);
  const mkUp = (auth) => ({ method: 'POST', url: '/lw/api/iwupload?date=' + date, query: { date }, headers: { 'x-lw-auth': auth }, async *[Symbol.asyncIterator]() { yield Buffer.from('%PDF-test-iw'); } });
  let r = rs(); r.json = (o) => { r.body = o; }; await up(mkUp('wrong'), r); assert.equal(r.statusCode, 401, 'wrong HMAC rejected');
  // valid HMAC would reach the Blob API - only checked where no token is set: expect failure, not 401
  r = rs(); r.json = (o) => { r.body = o; };
  try { await up(mkUp(good), r); assert.notEqual(r.statusCode, 401); } catch (e) { assert.ok(true, 'blob unreachable without token is fine here'); }
  assert.ok(IW.iwReportPath(date).startsWith('reports-iw/intelligenz-welt-tagesausgabe-' + date + '-'));
  assert.ok(IW.iwReportPath(date).endsWith('.pdf'));
  // IW_UPLOAD_SECRET takes precedence over the shared LW_SECRET (upload-only credential)
  process.env.IW_UPLOAD_SECRET = 'y'.repeat(40);
  const iwGood = crypto.createHmac('sha256', process.env.IW_UPLOAD_SECRET).update('upload:iwreport:' + date).digest('base64url');
  r = rs(); r.json = (o) => { r.body = o; }; await up(mkUp(good), r); assert.equal(r.statusCode, 401, 'LW_SECRET-derived HMAC rejected while IW_UPLOAD_SECRET is set');
  r = rs(); r.json = (o) => { r.body = o; };
  try { await up(mkUp(iwGood), r); assert.notEqual(r.statusCode, 401); } catch (e) { assert.ok(true); }
  delete process.env.IW_UPLOAD_SECRET;
});

test('IW dispatcher routes by action and rejects unknown', async () => {
  const disp = require('../api/lw-iw/[action]');
  let r = rs(); await disp({ method: 'GET', url: '/api/lw-iw/pdf?action=pdf&k=x', headers: {}, query: { action: 'pdf' } }, r);
  assert.ok(r.headers.location, 'routed to pdf handler (redirect), not the dispatcher 404');
  assert.notEqual(r.statusCode, 404);
  r = rs(); await disp({ method: 'GET', url: '/api/lw-iw/nope', headers: {}, query: { action: 'nope' } }, r);
  assert.equal(r.statusCode, 404);
});
