'use strict';
process.env.LW_SECRET = 'x'.repeat(40); process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry'; process.env.API_URL = 'https://api.test';
const test = require('node:test'); const assert = require('node:assert');
const L = require('../api/_lw'); const sub = require('../api/_lwh/subscribe'); const conf = require('../api/_lwh/confirm'); const pdf = require('../api/_lwh/pdf'); const un = require('../api/_lwh/unsub');
const mk = (method, url, body) => ({ method, url, headers: { 'x-forwarded-for': '203.0.113.9' }, body });
const rs = () => { const r = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, end(b) { this.body = b; } }; return r; };
test('DOI flow: no PDF before confirm, log filled, unsubscribe works', async () => {
  let r = rs(); await sub(mk('POST', '/api/subscribe', { email: 'A@Test.de', consent: true }), r); assert.equal(r.statusCode, 200);
  const mail = require('../api/_lw').sendMail.last; assert.ok(mail.text.includes('/api/confirm?t='));
  assert.ok(!/\.pdf/.test(mail.html + mail.text), 'DOI mail must not contain the PDF');
  assert.ok(!/<img/i.test(mail.html), 'no tracking pixel');
  const id = L.idOf('a@test.de'); let rec = await L.store.get(id);
  assert.equal(rec.textVersion, L.TEXT_VERSION); assert.equal(rec.confirmedAt, null); assert.equal(rec.signupIp, '203.0.113.9');
  const t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  r = rs(); await pdf(mk('GET', '/api/pdf?k=' + L.token('dl', id, 0)), r); assert.match(r.headers.location, /tagesbericht-anmelden/);
  let segNames = []; const origSeg = L.addToSegment; L.addToSegment = async (e, n) => { segNames.push(n || 'KI Fachblatt Tagesbericht'); };
  r = rs(); await conf(mk('GET', '/api/confirm?t=' + encodeURIComponent(t)), r); assert.match(r.headers.location, /tagesbericht-bestaetigt#k=/);
  assert.deepEqual(segNames, ['KI Fachblatt Tagesbericht'], 'v4 confirm joins only Tagesbericht segment; weekly eligibility comes from nlOptIn record, not segments'); L.addToSegment = origSeg;
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
  const tksub = require('../api/_lwh/tksub'), tkdl = require('../api/_lwh/tkdl');
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
  const asub = require('../api/_atlas/atlassub'), adl = require('../api/_atlas/atlasdl');
  let r = rs(); await asub(mk('POST', '/api/atlassub', { email: 'M@Test.de', consent: true }), r); assert.equal(r.statusCode, 200);
  const mail = require('../api/_lw').sendMail.last; assert.ok(mail.text.includes('s=atlas'));
  assert.ok(!/\.zip/.test(mail.html + mail.text)); assert.ok(!/<img/i.test(mail.html));
  const id = L.idOf('m@test.de'); assert.equal((await L.store.get(id)).textVersion, L.ATLAS_TEXT_VERSION);
  global.__atlas = { [L.ATLAS_VERSION]: Buffer.from('PK-test') };
  r = rs(); await adl(mk('GET', '/api/atlasdl?k=' + L.token('dl', id, 0)), r); assert.match(r.headers.location, /\/atlas-daten-anmelden$/);
  const t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  let aSegN = 0; const aOrigSeg = L.addToSegment; L.addToSegment = async () => { aSegN++; };
  r = rs(); await conf(mk('GET', '/api/confirm?s=atlas&t=' + encodeURIComponent(t)), r); assert.match(r.headers.location, /atlas-daten-bestaetigt#k=/);
  assert.equal(aSegN, 0, 'atlas confirm must not join the Tagesbericht segment'); L.addToSegment = aOrigSeg;
  const k = r.headers.location.split('#k=')[1];
  r = rs(); await adl(mk('GET', '/api/atlasdl?k=' + k), r); assert.equal(r.statusCode, 200); assert.equal(r.headers['content-type'], 'application/zip'); assert.equal(String(r.body), 'PK-test');
});

test('atlas dispatcher routes by action and rejects unknown', async () => {
  const disp = require('../api/lw-atlas/[action]');
  let r = rs(); await disp({ method: 'GET', url: '/api/lw-atlas/dl?action=dl&k=x', headers: {}, query: { action: 'dl' } }, r);
  assert.ok(r.headers.location, 'routed to dl handler (redirect), not the dispatcher 404');
  assert.notEqual(r.statusCode, 404);
  r = rs(); await disp({ method: 'GET', url: '/api/lw-atlas/nope', headers: {}, query: { action: 'nope' } }, r);
  assert.equal(r.statusCode, 404);
});

test('atlas: expired tokens are rejected (dl and doi)', async () => {
  const adl = require('../api/_atlas/atlasdl'), conf2 = require('../api/_lwh/confirm');
  const id = L.idOf('exp@test.de');
  await L.store.put(id, { email: 'exp@test.de', signupAt: new Date().toISOString(), signupIp: '203.0.113.9', textVersion: L.ATLAS_TEXT_VERSION, source: 'atlas', confirmedAt: new Date().toISOString(), confirmIp: '203.0.113.9', unsubscribedAt: null });
  global.__atlas = { [L.ATLAS_VERSION]: Buffer.from('PK-test') };
  let r = rs(); await adl(mk('GET', '/api/atlasdl?k=' + L.token('dl', id, -3600)), r);
  assert.match(r.headers.location, /atlas-daten-anmelden/, 'expired dl token must not get the ZIP');
  r = rs(); await conf2(mk('GET', '/api/confirm?s=atlas&t=' + encodeURIComponent(L.token('doi', id, -3600))), r);
  assert.match(r.headers.location, /atlas-daten-bestaetigt\?e=1/, 'expired doi token must fail closed');
});

test('weekly add-on: confirmed reader gets scoped weekly DOI; guards, throttle, replay-safe proof', async () => {
  const em = 'addon@test.de';
  // 1) Tagesbericht-only signup + confirm (legacy reader state: confirmed, nlOptIn false)
  let r = rs(); await sub(mk('POST', '/api/subscribe', { email: em, consent: true }), r); assert.equal(r.statusCode, 200);
  let mail = L.sendMail.last; assert.ok(!/Wochenrückblick/.test(mail.subject), 'no weekly wording in plain signup');
  const id = L.idOf(em);
  let t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  r = rs(); await conf(mk('GET', '/api/confirm?t=' + encodeURIComponent(t)), r);
  let rec = await L.store.get(id);
  assert.equal(rec.nlOptIn, false, 'legacy state: no weekly opt-in');
  const proof = { confirmedAt: rec.confirmedAt, confirmIp: rec.confirmIp, signupAt: rec.signupAt, textVersion: rec.textVersion };
  // 2) plain re-signup: silent no-op, no mail
  L.sendMail.last = null;
  r = rs(); await sub(mk('POST', '/api/subscribe', { email: em, consent: true }), r); assert.equal(r.statusCode, 200);
  assert.equal(L.sendMail.last, null, 'plain re-signup stays a silent no-op');
  // 3) re-signup with weekly box: scoped weekly DOI, record untouched before confirm
  r = rs(); await sub(mk('POST', '/api/subscribe', { email: em, consent: true, nl: true }), r); assert.equal(r.statusCode, 200);
  mail = L.sendMail.last; assert.ok(mail, 'weekly DOI sent');
  assert.ok(/Wochenrückblick/.test(mail.subject) && !/Tagesbericht und/.test(mail.subject), 'weekly-scoped wording only');
  assert.ok(!/<img/i.test(mail.html), 'no tracking pixel');
  rec = await L.store.get(id);
  assert.equal(rec.nlOptIn, false, 'no opt-in before confirm');
  assert.ok(rec.nlWeeklyReqAt, 'throttle marker claimed atomically');
  // 4) immediate repeat: throttled, no second mail
  L.sendMail.last = null;
  r = rs(); await sub(mk('POST', '/api/subscribe', { email: em, consent: true, nl: true }), r); assert.equal(r.statusCode, 200);
  assert.equal(L.sendMail.last, null, 'throttled repeat sends nothing');
  // 5) confirm add-on: only weekly fields, Tagesbericht proof untouched
  t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  r = rs(); await conf(mk('GET', '/api/confirm?t=' + encodeURIComponent(t)), r);
  assert.match(r.headers.location, /tagesbericht-bestaetigt\?nl=1/);
  rec = await L.store.get(id);
  assert.equal(rec.nlOptIn, true);
  assert.ok(rec.nlOptInConfirmedAt && rec.nlConfirmIp && rec.nlTextVersion, 'own weekly consent proof');
  assert.equal(rec.confirmedAt, proof.confirmedAt); assert.equal(rec.confirmIp, proof.confirmIp);
  assert.equal(rec.signupAt, proof.signupAt); assert.equal(rec.textVersion, proof.textVersion);
  assert.equal(rec.unsubscribedAt, null);
  const firstNlProof = rec.nlOptInConfirmedAt;
  // 6) replay of the same link: success page, first proof immutable
  r = rs(); await conf(mk('GET', '/api/confirm?t=' + encodeURIComponent(t)), r);
  assert.match(r.headers.location, /tagesbericht-bestaetigt\?nl=1/);
  rec = await L.store.get(id);
  assert.equal(rec.nlOptInConfirmedAt, firstNlProof, 'replay keeps the first proof');
  // 7) further re-signup with weekly box: no-op, no mail
  L.sendMail.last = null;
  r = rs(); await sub(mk('POST', '/api/subscribe', { email: em, consent: true, nl: true }), r); assert.equal(r.statusCode, 200);
  assert.equal(L.sendMail.last, null, 'already-opted-in re-signup stays silent');
});

test('weekly add-on guards: unconfirmed record and weekly-unsubscribed reader are refused', async () => {
  // unconfirmed: doi-nl token for a fresh, unconfirmed record -> error page, no weekly fields
  let r = rs(); await sub(mk('POST', '/api/subscribe', { email: 'addon2@test.de', consent: true }), r);
  const id2 = L.idOf('addon2@test.de');
  r = rs(); await conf(mk('GET', '/api/confirm?t=' + encodeURIComponent(L.token('doi-nl', id2, 100))), r);
  assert.match(r.headers.location, /\?e=1/);
  const rec2 = await L.store.get(id2); assert.ok(!rec2.nlOptIn, 'no weekly opt-in without Tagesbericht confirmation');
  // weekly-unsubscribed (nlUnsub.kifb): no mail, confirm refused - no weekly re-opt-in path
  const id3 = L.idOf('addon3@test.de');
  await L.store.put(id3, { email: 'addon3@test.de', signupAt: new Date().toISOString(), signupIp: '203.0.113.9', textVersion: L.TEXT_VERSION, nlOptIn: false, confirmedAt: new Date().toISOString(), confirmIp: '203.0.113.9', unsubscribedAt: null, nlUnsub: { kifb: { at: new Date().toISOString() } } });
  L.sendMail.last = null;
  r = rs(); await sub(mk('POST', '/api/subscribe', { email: 'addon3@test.de', consent: true, nl: true }), r); assert.equal(r.statusCode, 200);
  assert.equal(L.sendMail.last, null, 'no weekly re-opt-in mail after weekly unsubscribe');
  r = rs(); await conf(mk('GET', '/api/confirm?t=' + encodeURIComponent(L.token('doi-nl', id3, 100))), r);
  assert.match(r.headers.location, /\?e=1/, 'confirm refuses weekly-unsubscribed record');
});
