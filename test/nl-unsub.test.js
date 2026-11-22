'use strict';
// Isolierter Abmeldenachweis je Site: Token-Zweckbindung, Store-Routing (kifb->optin/,
// iw->optin-iw/, fa->optin-fa/), Schreibverhalten bei vorhandenem/fehlendem Record,
// Idempotenz. Komplett in-memory, kein Provider, keine echten Bestaende.
process.env.LW_SECRET = 'x'.repeat(40); process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry'; process.env.API_URL = 'https://api.test';
const test = require('node:test'); const assert = require('node:assert/strict');
const L = require('../api/_lw');
const nlUnsub = require('../api/_nlh/unsub');
const IW = require('../api/_iw/iwlib');
const FA = require('../api/_fa/falib');

const mk = (method, url) => ({ method, url, query: {}, headers: { 'x-forwarded-for': '203.0.113.9' } });
const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } });
const put = (store, email) => store.put(L.idOf(email), { email, source: 'test', signupAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), unsubscribedAt: null, nlOptIn: true });

test('iw: nlunsub schreibt nur optin-iw/ nlUnsub.iw, Redirect auf IW-Abmeldeseite', async () => {
  const em = 'iw-unsub-proof@test.de'; const id = L.idOf(em);
  await put(IW.iwStore, em);
  const t = L.token('nl-iw', id, 3600);
  const r = rs(); await nlUnsub(mk('GET', '/lw/api/nlunsub?site=iw&t=' + encodeURIComponent(t)), r);
  assert.equal(r.headers.location, 'https://intelligenz-welt.de/abmelden/?ok=1');
  const rec = await IW.iwStore.get(id);
  assert.ok(rec.nlUnsub && rec.nlUnsub.iw && rec.nlUnsub.iw.at, 'nlUnsub.iw gesetzt');
  assert.equal(rec.nlUnsub.iw.provider, 'n/a', 'ohne konfiguriertes Topic ehrlich n/a, kein falsches ok');
  assert.ok(!rec.unsubscribedAt, 'DOI-Record bleibt unberuehrt');
  assert.equal(await L.store.get(id), null, 'kifb-Bestand unberuehrt');
  assert.equal(await FA.faStore.get(id), null, 'fa-Bestand unberuehrt');
});

test('kifb: nlunsub schreibt nur optin/ nlUnsub.kifb; Zweitaufruf idempotent (kein Rewrite)', async () => {
  const em = 'kifb-unsub-proof@test.de'; const id = L.idOf(em);
  await put(L.store, em);
  const t = L.token('nl-kifb', id, 3600);
  let r = rs(); await nlUnsub(mk('GET', '/lw/api/nlunsub?site=kifb&t=' + encodeURIComponent(t)), r);
  assert.equal(r.headers.location, 'https://kifachblatt.de/abmelden?ok=1');
  const rec1 = await L.store.get(id);
  assert.ok(rec1.nlUnsub && rec1.nlUnsub.kifb && rec1.nlUnsub.kifb.at);
  r = rs(); await nlUnsub(mk('GET', '/lw/api/nlunsub?site=kifb&t=' + encodeURIComponent(t)), r);
  const rec2 = await L.store.get(id);
  assert.equal(rec2.nlUnsub.kifb.at, rec1.nlUnsub.kifb.at, 'Zeitstempel unveraendert: kein Rewrite bei provider ok/n-a');
  assert.equal(await IW.iwStore.get(id), null, 'iw-Bestand unberuehrt');
  assert.equal(await FA.faStore.get(id), null, 'fa-Bestand unberuehrt');
});

test('fa: POST-One-Click liefert JSON ok:true und schreibt nur optin-fa/ nlUnsub.fa', async () => {
  const em = 'fa-unsub-proof@test.de'; const id = L.idOf(em);
  await put(FA.faStore, em);
  const t = L.token('nl-fa', id, 3600);
  const r = rs(); await nlUnsub(mk('POST', '/lw/api/nlunsub?site=fa&t=' + encodeURIComponent(t)), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  const rec = await FA.faStore.get(id);
  assert.ok(rec.nlUnsub && rec.nlUnsub.fa && rec.nlUnsub.fa.at);
  assert.equal(await L.store.get(id), null);
  assert.equal(await IW.iwStore.get(id), null);
});

test('recordloses Token: kein Schreibzugriff irgendwo, trotzdem Erfolgs-Redirect (No-Op)', async () => {
  const id = L.idOf('niemand@test.de');
  for (const site of ['iw', 'fa', 'kifb']) {
    const t = L.token('nl-' + site, id, 3600);
    const r = rs(); await nlUnsub(mk('GET', '/lw/api/nlunsub?site=' + site + '&t=' + encodeURIComponent(t)), r);
    assert.match(r.headers.location, /ok=1/, site + ': No-Op landet auf Erfolgsseite');
    assert.notEqual(r.headers.location.includes('e=1'), true);
  }
  assert.equal(await L.store.get(id), null);
  assert.equal(await IW.iwStore.get(id), null);
  assert.equal(await FA.faStore.get(id), null);
});

test('Zweckbindung: fa-Token an site=iw verwirft still, kein Schreibzugriff', async () => {
  const em = 'zweck@test.de'; const id = L.idOf(em);
  await put(IW.iwStore, em);
  const t = L.token('nl-fa', id, 3600); // falscher Zweck fuer site=iw
  const r = rs(); await nlUnsub(mk('GET', '/lw/api/nlunsub?site=iw&t=' + encodeURIComponent(t)), r);
  const rec = await IW.iwStore.get(id);
  assert.ok(!rec.nlUnsub, 'kein nlUnsub geschrieben');
});
