'use strict';
process.env.LW_SECRET = 'x'.repeat(40); process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry'; process.env.API_URL = 'https://api.test';
const test = require('node:test'); const assert = require('node:assert');
const L = require('../api/_lw'); const sub = require('../api/lw-subscribe'); const conf = require('../api/lw-confirm'); const pdf = require('../api/lw-pdf'); const un = require('../api/lw-unsub');
const mk = (method, url, body) => ({ method, url, headers: { 'x-forwarded-for': '203.0.113.9' }, body });
const rs = () => { const r = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } }; return r; };
test('DOI flow: no PDF before confirm, log filled, unsubscribe works', async () => {
  let r = rs(); await sub(mk('POST', '/api/subscribe', { email: 'A@Test.de', consent: true }), r); assert.equal(r.statusCode, 200);
  const mail = require('../api/_lw').sendMail.last; assert.ok(mail.text.includes('/api/confirm?t='));
  assert.ok(!/\.pdf/.test(mail.html + mail.text), 'DOI mail must not contain the PDF');
  assert.ok(!/<img/i.test(mail.html), 'no tracking pixel');
  const id = L.idOf('a@test.de'); let rec = await L.store.get(id);
  assert.equal(rec.textVersion, L.TEXT_VERSION); assert.equal(rec.confirmedAt, null); assert.equal(rec.signupIp, '203.0.113.9');
  const t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  r = rs(); await pdf(mk('GET', '/api/pdf?k=' + L.token('dl', id, 0)), r); assert.match(r.headers.location, /tagesbericht-anmelden/);
  r = rs(); await conf(mk('GET', '/api/confirm?t=' + encodeURIComponent(t)), r); assert.match(r.headers.location, /tagesbericht-bestaetigt#k=/);
  rec = await L.store.get(id); assert.ok(rec.confirmedAt && rec.confirmIp);
  const k = r.headers.location.split('#k=')[1];
  global.__reports = { [new Date().toISOString().slice(0,10)]: Buffer.from('%PDF-test') };
  r = rs(); await pdf(mk('GET', '/api/pdf?k=' + k), r); assert.equal(r.statusCode, 200); assert.equal(r.headers['content-type'], 'application/pdf'); assert.equal(String(r.body), '%PDF-test');
  r = rs(); await un(mk('GET', '/api/unsub?t=' + encodeURIComponent(L.token('unsub', id, 0))), r); assert.match(r.headers.location, /abmelden\?ok=1/);
  r = rs(); await pdf(mk('GET', '/api/pdf?k=' + k), r); assert.match(r.headers.location, /tagesbericht-anmelden/);
});
test('rejects missing consent, bad email, forged token', async () => {
  let r = rs(); await sub(mk('POST', '/', { email: 'a@test.de', consent: false }), r); assert.equal(r.statusCode, 400);
  r = rs(); await sub(mk('POST', '/', { email: 'nope', consent: true }), r); assert.equal(r.statusCode, 400);
  assert.equal(L.verify('dl', 'abc.def'), null); assert.equal(L.verify('doi', L.token('dl', 'x', 0)), null);
});
test('toolkit flow: DOI -> confirm -> ZIP only after confirm', async () => {
  const tksub = require('../api/lw-tksub'), tkdl = require('../api/lw-tkdl');
  let r = rs(); await tksub(mk('POST', '/api/tksub', { email: 'T@Test.de', consent: true }), r); assert.equal(r.statusCode, 200);
  const mail = require('../api/_lw').sendMail.last; assert.ok(mail.text.includes('s=tk'));
  assert.ok(!/\.zip/.test(mail.html + mail.text)); assert.ok(!/<img/i.test(mail.html));
  const id = L.idOf('t@test.de'); assert.equal((await L.store.get(id)).textVersion, L.TK_TEXT_VERSION);
  global.__toolkit = { [L.TK_VERSION]: Buffer.from('PK-test') };
  r = rs(); await tkdl(mk('GET', '/api/tkdl?k=' + L.token('dl', id, 0)), r); assert.match(r.headers.location, /\/toolkit$/);
  const t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  r = rs(); await conf(mk('GET', '/api/confirm?s=tk&t=' + encodeURIComponent(t)), r); assert.match(r.headers.location, /toolkit-bestaetigt#k=/);
  const k = r.headers.location.split('#k=')[1];
  r = rs(); await tkdl(mk('GET', '/api/tkdl?k=' + k), r); assert.equal(r.statusCode, 200); assert.equal(r.headers['content-type'], 'application/zip'); assert.equal(String(r.body), 'PK-test');
  r = rs(); await tksub(mk('POST', '/api/tksub', { email: 't@test.de', consent: true }), r); assert.ok(require('../api/_lw').sendMail.last.text.includes('/toolkit-bestaetigt#k='));
});

test('atlas flow: DOI -> confirm -> ZIP only after confirm', async () => {
  const asub = require('../api/lw-atlassub'), adl = require('../api/lw-atlasdl');
  let r = rs(); await asub(mk('POST', '/api/atlassub', { email: 'M@Test.de', consent: true }), r); assert.equal(r.statusCode, 200);
  const mail = require('../api/_lw').sendMail.last; assert.ok(mail.text.includes('s=atlas'));
  assert.ok(!/\.zip/.test(mail.html + mail.text)); assert.ok(!/<img/i.test(mail.html));
  const id = L.idOf('m@test.de'); assert.equal((await L.store.get(id)).textVersion, L.ATLAS_TEXT_VERSION);
  global.__atlas = { [L.ATLAS_VERSION]: Buffer.from('PK-test') };
  r = rs(); await adl(mk('GET', '/api/atlasdl?k=' + L.token('dl', id, 0)), r); assert.match(r.headers.location, /\/atlas-daten-anmelden$/);
  const t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  r = rs(); await conf(mk('GET', '/api/confirm?s=atlas&t=' + encodeURIComponent(t)), r); assert.match(r.headers.location, /atlas-daten-bestaetigt#k=/);
  const k = r.headers.location.split('#k=')[1];
  r = rs(); await adl(mk('GET', '/api/atlasdl?k=' + k), r); assert.equal(r.statusCode, 200); assert.equal(r.headers['content-type'], 'application/zip'); assert.equal(String(r.body), 'PK-test');
});
