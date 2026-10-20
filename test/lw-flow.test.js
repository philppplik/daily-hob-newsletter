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
