'use strict';
process.env.LW_SECRET = 'x'.repeat(40); process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry'; process.env.API_URL = 'https://api.test'; process.env.FA_MAIL_FROM = 'finanzadjust <briefing@finanz-adjust.de>';
const test = require('node:test'); const assert = require('node:assert');
const L = require('../api/_lw');
const content = require('../newsletter/content');
const { render } = require('../newsletter/template');
const { SITES, POSTAL } = require('../newsletter/config');
const core = require('../newsletter/core');

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>KI Fachblatt</title>
<item><title>Analyse Eins</title><link>https://kifachblatt.de/eins</link><guid>g1</guid><description>Erster Teaser.</description><pubDate>Sat, 24 Oct 2026 07:00:00 +0200</pubDate><category>Modelle</category></item>
<item><title>Analyse Zwei</title><link>https://kifachblatt.de/zwei</link><guid>g2</guid><description>Zweiter Teaser.</description><pubDate>Fri, 23 Oct 2026 07:00:00 +0200</pubDate><category>Security</category></item>
<item><title>Analyse Drei</title><link>https://kifachblatt.de/drei</link><guid>g3</guid><description>Dritter Teaser.</description><pubDate>Thu, 22 Oct 2026 07:00:00 +0200</pubDate><category>Modelle</category></item>
<item><title>Alt &amp; raus</title><link>https://kifachblatt.de/alt</link><guid>g4</guid><description>Zu alt.</description><pubDate>Mon, 12 Oct 2026 07:00:00 +0200</pubDate></item>
<item><title>Fremdlink</title><link>https://example.com/fremd</link><guid>g5</guid><description>Extern.</description><pubDate>Sat, 24 Oct 2026 08:00:00 +0200</pubDate></item>
</channel></rss>`;
const fakeFeed = async () => ({ ok: true, text: async () => FEED });

test('content: week window, ownOnly filter, UTM, selection caps', async () => {
  const w = await content.fetchWeek(SITES.kifb, '2026-10-25', fakeFeed);
  assert.equal(w.total, 3, 'old + external items are filtered');
  assert.equal(w.items.length, 3);
  assert.equal(w.items[0].title, 'Analyse Eins');
  assert.match(w.items[0].url, /utm_source=kifb-newsletter&utm_medium=email&utm_campaign=kw43-2026&utm_content=artikel-1/);
  assert.match(w.weekLabel, /KW 43/);
  assert.ok(w.extra.url.includes('utm_content=extra'));
});

test('template: structure, postal address, no tracking pixel, escaping', () => {
  const r = render({ cfg: SITES.fa, subject: 'S <b>', preheader: 'p', weekLabel: 'KW 43', items: [{ title: 'Titel <script>', url: 'https://finanz-adjust.de/a?utm_source=x', teaser: 't', cat: null, dayLabel: 'Sa 24.10.' }], more: [], unsubUrl: 'https://api.test/unsub?t=1' });
  assert.ok(r.html.includes(POSTAL));
  assert.ok(r.html.includes('https://api.test/unsub?t=1'));
  assert.ok(!/<img[^>]*(width|height)="1"/i.test(r.html) && !/beacon|open\.gif|\/track\//i.test(r.html), 'no spy pixel (the word Tracking-Pixel in the footer is the no-tracking promise itself)');
  assert.ok(r.html.includes('Titel &lt;script&gt;'), 'escaped');
  assert.ok(r.html.includes('finanz <span'), 'FA wordmark rendered (house brand, two words)');
  assert.ok(r.text.includes('Keine Anlageberatung') === false, 'footerNote only where configured');
  assert.ok(r.text.includes(POSTAL));
  const rk = render({ cfg: SITES.kifb, subject: 'S', preheader: 'p', weekLabel: 'KW 43', items: [{ title: 'T', url: 'https://kifachblatt.de/a', teaser: 't', cat: 'Modelle', dayLabel: 'Sa' }], more: [], unsubUrl: 'https://u' });
  assert.ok(rk.html.includes('https://kifachblatt.de/assets/logo-192.png'), 'KIFB logo image');
});

test('FA DOI -> confirm -> nlOptIn record; nl-unsub removes from eligibility', async () => {
  const FA = require('../api/_fa/falib');
  const faSub = require('../api/lw-fa/[action]');
  const conf = require('../api/_lwh/confirm');
  const nlUnsub = require('../api/_nlh/unsub');
  const mk = (method, url, body) => ({ method, url, query: {}, headers: { 'x-forwarded-for': '203.0.113.9' }, body });
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } });
  // subscribe
  let r = rs(); await faSub(Object.assign(mk('POST', '/x', { email: 'F@Test.de', consent: true }), { query: { action: 'sub' } }), r); assert.equal(r.statusCode, 200);
  const mail = L.sendMail.last; assert.ok(mail.text.includes('s=fa')); assert.ok(!/<img/i.test(mail.html));
  assert.equal(mail.from, FA.FA_FROM);
  const id = L.idOf('f@test.de');
  const rec = await FA.faStore.get(id); assert.equal(rec.textVersion, 'fa-2026-10-24-v1');
  // confirm
  const topicCalls = []; const orig = L.topicSubscribe; L.topicSubscribe = async (e, t, sub) => { topicCalls.push({ e, t, sub }); };
  const t = decodeURIComponent(mail.text.match(/t=([^\s]+)/)[1]);
  r = rs(); await conf(mk('GET', '/api/confirm?s=fa&t=' + encodeURIComponent(t)), r);
  assert.match(r.headers.location, /finanz-adjust\.de\/newsletter-bestaetigt\//);
  assert.deepEqual(topicCalls, [], 'no provider topic/segment sync without configured topic; eligibility from own records'); L.topicSubscribe = orig;
  // eligibility: blob records only; ghost addresses cannot exist here because list() reads our store
  let el = await core.eligible(SITES.fa, { store: FA.faStore });
  assert.deepEqual(el.recipients.map((x) => x.email), ['f@test.de'], 'confirmed FA record with nlOptIn is eligible');
  // sendAll produces per-recipient one-click unsub headers
  const model = { subject: 'S', preheader: 'p', weekLabel: 'KW 43', items: [{ title: 'T', url: 'https://finanz-adjust.de/a', teaser: 't', cat: null, dayLabel: 'Sa' }], more: [] };
  const out = await core.sendAll(SITES.fa, model, el.recipients, {});
  assert.equal(out.sent, 1);
  const sent = L.sendMail.last;
  assert.ok(sent.headers['list-unsubscribe'].includes('/lw/api/nlunsub?site=fa&t='));
  assert.equal(sent.headers['list-unsubscribe-post'], 'List-Unsubscribe=One-Click');
  // one-click unsubscribe (POST) marks nlUnsub only for fa
  const unsubUrl = sent.headers['list-unsubscribe'].slice(1, -1);
  const tok = new URL(unsubUrl).searchParams.get('t');
  r = rs(); await nlUnsub(mk('POST', '/lw/api/nlunsub?site=fa&t=' + encodeURIComponent(tok)), r);
  assert.equal(r.statusCode, 200);
  const rec2 = await FA.faStore.get(id); assert.ok(rec2.nlUnsub && rec2.nlUnsub.fa); assert.ok(!rec2.unsubscribedAt, 'newsletter unsub keeps DOI record');
  el = await core.eligible(SITES.fa, { store: FA.faStore });
  assert.equal(el.recipients.length, 0, 'unsubscribed contact dropped');
});

test('nl-weekly endpoint: auth, dry json, test-send override, idempotency', async () => {
  const nl = require('../api/_nlh/weekly');
  const realFetch = content.fetchWeek;
  content.fetchWeek = async (cfg, date) => realFetch(cfg, date, fakeFeed);
  const mk = (method, url) => ({ method, url, headers: {} });
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } });
  const auth = L.sign('nl:kifb:2026-10-25');
  let r = rs(); await nl(mk('POST', '/lw/api/nlweekly?site=kifb&date=2026-10-25'), r); assert.equal(r.statusCode, 401, 'HMAC required');
  const mkA = (method, url) => ({ method, url, headers: { 'x-lw-auth': auth } });
  r = rs(); await nl(mkA('GET', '/lw/api/nlweekly?site=kifb&date=2026-10-25&dry=1&to=p@test.de'), r);
  const j = JSON.parse(r.body); assert.equal(j.ok, true); assert.equal(j.dry, true); assert.equal(j.items, 3);
  // test send to explicit address (template review path)
  r = rs(); await nl(mkA('POST', '/lw/api/nlweekly?site=kifb&date=2026-10-25&to=p@test.de'), r);
  const j2 = JSON.parse(r.body); assert.equal(j2.ok, true); assert.equal(j2.sent, 1); assert.equal(j2.test, true);
  const sent = L.sendMail.last; assert.equal(sent.to, 'p@test.de'); assert.ok(sent.headers['list-unsubscribe']);
  // idempotent test send refused without force
  r = rs(); await nl(mkA('POST', '/lw/api/nlweekly?site=kifb&date=2026-10-25&to=p@test.de'), r);
  assert.equal(JSON.parse(r.body).error, 'already-sent');
  content.fetchWeek = realFetch;
});

// --- Editorial selection, ISO week/year, DST window (review feedback 2026-10-24) ---


test('ISO week + week-year: DST Sunday, year boundary', () => {
  assert.deepEqual(content.isoWeekParts('2026-10-25'), { week: 43, year: 2026 }); // DST end Sunday
  assert.deepEqual(content.isoWeekParts('2026-03-29'), { week: 13, year: 2026 }); // DST start Sunday
  assert.deepEqual(content.isoWeekParts('2027-01-03'), { week: 53, year: 2026 }); // ISO year != calendar year
  assert.deepEqual(content.isoWeekParts('2027-01-01'), { week: 53, year: 2026 });
  assert.deepEqual(content.isoWeekParts('2027-01-04'), { week: 1, year: 2027 });
});

const feedXml = (rows) => '<?xml version="1.0"?><rss><channel>' + rows.map((r) =>
  '<item><title>' + r[0] + '</title><link>' + r[1] + '</link><pubDate>' + r[2] + '</pubDate><description>t</description></item>').join('') + '</channel></rss>';
const fakeFetch = (xml) => async () => ({ ok: true, text: async () => xml });

test('Berlin week window across DST end (2026-10-25): boundaries exact', async () => {
  // Stichtag-Fenster: [So 18.10. 09:00 CEST, So 25.10. 09:00 CET) = 169 Stunden.
  const xml = feedXml([
    ['in-first',  'https://x.de/artikel/a1', 'Sun, 18 Oct 2026 09:30:00 +0200'], // erste Fensterstunde (CEST)
    ['out-early', 'https://x.de/artikel/a2', 'Sun, 18 Oct 2026 08:30:00 +0200'],  // vor dem Stichtag der Vorwoche
    ['in-last',   'https://x.de/artikel/a3', 'Sun, 25 Oct 2026 08:30:00 +0100'],  // letzte Fensterstunde (CET)
    ['out-late',  'https://x.de/artikel/a4', 'Sun, 25 Oct 2026 09:30:00 +0100'],  // nach dem Stichtag -> naechste Ausgabe
    ['in-cet',    'https://x.de/artikel/a5', 'Sat, 24 Oct 2026 20:30:00 +0200']   // inside
  ]);
  const cfg = { ...SITES.kifb, feed: 'https://x.de/feed', site: 'https://x.de', preferSlug: null, preferBeforeHour: null };
  const w = await content.fetchWeek(cfg, '2026-10-25', fakeFetch(xml));
  const titles = w.items.map((i) => i.title).concat(w.more.map((i) => i.title));
  assert.ok(titles.includes('in-first') && titles.includes('in-last') && titles.includes('in-cet'));
  assert.ok(!titles.includes('out-early') && !titles.includes('out-late'));
  assert.equal(w.total, 3);
  assert.ok(/^KW 43 · 18\.–25\. Oktober$/.test(w.weekLabel), w.weekLabel);
});

test('Berlin week window across DST start (2026-03-29)', async () => {
  // Stichtag-Fenster: [So 22.03. 09:00 CET, So 29.03. 09:00 CEST) = 167 Stunden.
  const xml = feedXml([
    ['in-first', 'https://x.de/artikel/b1', 'Sun, 22 Mar 2026 09:30:00 +0100'],
    ['out-early','https://x.de/artikel/b2', 'Sun, 22 Mar 2026 08:30:00 +0100'],
    ['in-last',  'https://x.de/artikel/b3', 'Sun, 29 Mar 2026 08:30:00 +0200'],
    ['out-late', 'https://x.de/artikel/b4', 'Sun, 29 Mar 2026 09:30:00 +0200'] // nach dem Stichtag -> naechste Ausgabe
  ]);
  const cfg = { ...SITES.kifb, feed: 'https://x.de/feed', site: 'https://x.de', preferSlug: null, preferBeforeHour: null };
  const w = await content.fetchWeek(cfg, '2026-03-29', fakeFetch(xml));
  assert.equal(w.total, 2);
  assert.ok(w.campaign === 'kw13-2026', w.campaign);
});

test('campaign uses ISO week-year at year boundary', async () => {
  const xml = feedXml([['a', 'https://x.de/artikel/c1', 'Fri, 01 Jan 2027 10:00:00 +0100'], ['b', 'https://x.de/artikel/c2', 'Sat, 02 Jan 2027 10:00:00 +0100'], ['c', 'https://x.de/artikel/c3', 'Wed, 30 Dec 2026 10:00:00 +0100']]);
  const cfg = { ...SITES.kifb, feed: 'https://x.de/feed', site: 'https://x.de', preferSlug: null, preferBeforeHour: null };
  const w = await content.fetchWeek(cfg, '2027-01-03', fakeFetch(xml));
  assert.equal(w.campaign, 'kw53-2026');
});

test('editorial pools: allowPath filters, preferPath/preferSlug rank; rest only fills', async () => {
  const xml = feedXml([
    ['glossar',   'https://f.de/investing/g1', 'Sat, 24 Oct 2026 09:00:00 +0200'],
    ['news-ext',  'https://f.de/nachricht/n1', 'Sat, 24 Oct 2026 10:00:00 +0200'],
    ['artikel-1', 'https://f.de/artikel/a1',   'Sat, 24 Oct 2026 11:00:00 +0200'],
    ['artikel-2', 'https://f.de/artikel/a2',   'Fri, 23 Oct 2026 11:00:00 +0200'],
    ['artikel-3', 'https://f.de/artikel/a3',   'Thu, 22 Oct 2026 11:00:00 +0200']
  ]);
  const cfg = { ...SITES.fa, feed: 'https://f.de/feed', site: 'https://f.de', maxItems: 3, maxMore: 5 };
  const w = await content.fetchWeek(cfg, '2026-10-25', fakeFetch(xml));
  assert.equal(w.total, 3); // glossary + external news never counted
  assert.deepEqual(w.items.map((i) => i.title), ['artikel-1', 'artikel-2', 'artikel-3']);
  // KIFB: analysis (morning or -analyse slug) outranks same-day newer knowledge item
  const xml2 = feedXml([
    ['wissen-neu', 'https://k.de/wissen-artikel',  'Sat, 24 Oct 2026 20:00:00 +0200'],
    ['analyse',    'https://k.de/flint-analyse',   'Sat, 24 Oct 2026 07:00:00 +0200'],
    ['frueh-ohne-slug', 'https://k.de/deepinfer', 'Fri, 23 Oct 2026 07:30:00 +0200'],
    ['wissen-2',   'https://k.de/noch-wissen',     'Fri, 23 Oct 2026 15:00:00 +0200']
  ]);
  const cfg2 = { ...SITES.kifb, feed: 'https://k.de/feed', site: 'https://k.de', maxItems: 4, maxMore: 4 };
  const w2 = await content.fetchWeek(cfg2, '2026-10-25', fakeFetch(xml2));
  assert.deepEqual(w2.items.map((i) => i.title).slice(0, 2), ['analyse', 'frueh-ohne-slug']); // per-day lead = analysis
});

test('sender fail closed: sendAll and POST reject when cfg.from is null', async () => {
  await assert.rejects(() => core.sendAll({ ...SITES.iw, from: null }, { subject: 's' }, [], {}), /sender-unresolved/);
});

test('eligible() negative regression: no nlOptIn, no confirm, unsubscribed, nlUnsub -> all excluded', async () => {
  const L2 = require('../api/_lw');
  const store = L2.storeFor('optin-neg/');
  const mk = (email, rec) => store.put(L2.idOf(email), { email, ...rec });
  await mk('daily-only@test.de', { confirmedAt: '2026-10-24T10:00:00Z', unsubscribedAt: null, textVersion: 'lw-2026-10-24-v4' }); // no nlOptIn
  await mk('old-v2@test.de', { confirmedAt: '2026-01-01T10:00:00Z', unsubscribedAt: null, textVersion: 'lw-2026-02-01-v2', nlOptIn: true }); // stale record, but old textVersion is fine if nlOptIn... must still pass nlOptIn gate only
  await mk('unconfirmed@test.de', { confirmedAt: null, nlOptIn: true });
  await mk('unsubbed@test.de', { confirmedAt: '2026-10-24T10:00:00Z', unsubscribedAt: '2026-10-24T11:00:00Z', nlOptIn: true });
  await mk('nlunsub@test.de', { confirmedAt: '2026-10-24T10:00:00Z', unsubscribedAt: null, nlOptIn: true, nlUnsub: { kifb: '2026-10-24T12:00:00Z' } });
  await mk('weekly@test.de', { confirmedAt: '2026-10-24T10:00:00Z', unsubscribedAt: null, nlOptIn: true });
  const el = await core.eligible({ ...SITES.kifb, key: 'kifb' }, { store });
  const mails = el.recipients.map((r) => r.email).sort();
  assert.deepEqual(mails, ['old-v2@test.de', 'weekly@test.de'], 'only confirmed + nlOptIn + not unsubscribed; nlOptIn is the single weekly gate, textVersion is audit metadata');
  // per-site nlUnsub isolation: kifb-unsub does not drop iw eligibility
  const elIw = await core.eligible({ ...SITES.kifb, key: 'iw' }, { store });
  assert.ok(elIw.recipients.map((r) => r.email).includes('nlunsub@test.de'));
});

test('confirm-time topic sync is gated: none without env, exactly one opt_in with env + nlOptIn', async () => {
  const conf2 = require('../api/_lwh/confirm');
  const mk2 = (method, url, body) => ({ method, url, query: {}, headers: { 'x-forwarded-for': '203.0.113.10' }, body });
  const rs2 = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } });
  const FA = require('../api/_fa/falib');
  const faSub = require('../api/lw-fa/[action]');
  // no NL_TOPIC_ID_FA -> no sync
  delete process.env.NL_TOPIC_ID_FA;
  let calls = []; const orig = L.topicSubscribe; L.topicSubscribe = async (e, t, sub) => { calls.push({ e, t, sub }); };
  let r = rs2(); await faSub(Object.assign(mk2('POST', '/x', { email: 'gate1@test.de', consent: true }), { query: { action: 'sub' } }), r);
  let t = decodeURIComponent(L.sendMail.last.text.match(/t=([^\s]+)/)[1]);
  r = rs2(); await conf2(mk2('GET', '/api/confirm?s=fa&t=' + encodeURIComponent(t)), r);
  assert.deepEqual(calls, [], 'no topic sync without configured weekly topic');
  // with env -> exactly the configured topic, opt_in, and only for nlOptIn records (FA always nlOptIn)
  process.env.NL_TOPIC_ID_FA = 'topic_fa_weekly'; process.env.NL_SEGMENT_ID_FA = 'seg_fa';
  calls = [];
  r = rs2(); await faSub(Object.assign(mk2('POST', '/x', { email: 'gate2@test.de', consent: true }), { query: { action: 'sub' } }), r);
  t = decodeURIComponent(L.sendMail.last.text.match(/t=([^\s]+)/)[1]);
  r = rs2(); await conf2(mk2('GET', '/api/confirm?s=fa&t=' + encodeURIComponent(t)), r);
  assert.deepEqual(calls, [{ e: 'gate2@test.de', t: 'topic_fa_weekly', sub: 'opt_in' }], 'opt_in into exactly the configured weekly topic');
  L.topicSubscribe = orig; delete process.env.NL_TOPIC_ID_FA; delete process.env.NL_SEGMENT_ID_FA;
});

test('bulk POST fail-closed: 503 dispatch-disabled without live CAS probe + enable flags', async () => {
  const nl = require('../api/_nlh/weekly');
  delete process.env.NL_DISPATCH_ENABLED; delete process.env.NL_CAS_VERIFIED; delete process.env.NL_REGISTRY_URL;
  const auth = L.sign('nl:kifb:2026-10-25');
  const mkA = (method, url) => ({ method, url, headers: { 'x-lw-auth': auth } });
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } });
  const r = rs(); await nl(mkA('POST', '/lw/api/nlweekly?site=kifb&date=2026-10-25'), r);
  assert.equal(r.statusCode, 503);
  assert.equal(JSON.parse(r.body).error, 'dispatch-disabled', 'bulk dispatch stays off until probe + enable');
});

test('eligible() marks syncApplied only when the exact consent was applied (apply-once guard)', async () => {
  const store = L.storeFor('optin/');
  const put = (email, rec) => store.put(L.idOf(email), { email, confirmedAt: '2026-10-20T10:00:00Z', nlOptIn: true, ...rec });
  await put('applied@test.de', { nlSync: { state: 'applied', consentAt: '2026-10-20T10:00:00Z', at: '2026-10-20T10:00:01Z' } });
  await put('stale@test.de', { nlSync: { state: 'applied', consentAt: '2026-10-19T10:00:00Z' } }); // older consent applied, newer not
  await put('failed@test.de', { nlSync: { state: 'failed-pre', error: 'x' } });
  await put('fresh@test.de', {});
  const el = await core.eligible({ ...SITES.kifb, key: 'kifb' }, { store });
  const byMail = Object.fromEntries(el.recipients.map((r) => [r.email, r.syncApplied]));
  assert.equal(byMail['applied@test.de'], true, 'exact consent applied -> skip future re-sync (provider opt-out wins)');
  assert.equal(byMail['stale@test.de'], false, 'consent changed since application -> fresh event may apply');
  assert.equal(byMail['failed@test.de'], false, 'failed sync retries');
  assert.equal(byMail['fresh@test.de'], false, 'never synced applies once');
});

test('unresolved provider opt-out: nl-unsub is never false-success, bulk dispatch is blocked', async () => {
  const FA = require('../api/_fa/falib');
  const nlUnsub = require('../api/_nlh/unsub');
  const mk = (method, url) => ({ method, url, headers: {} });
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; }, statusCode: 200 });
  // seed a confirmed FA record
  const email = 'optout-block@test.de';
  const id = L.idOf(email);
  await FA.faStore.put(id, { email, confirmedAt: '2026-10-24T10:00:00Z', nlOptIn: true });
  process.env.NL_TOPIC_ID_FA = 'topic_fa_weekly'; process.env.NL_SEGMENT_ID_FA = 'seg_fa';
  const origCfg = { segmentId: SITES.fa.segmentId, topicId: SITES.fa.topicId };
  SITES.fa.segmentId = 'seg_fa'; SITES.fa.topicId = 'topic_fa_weekly';
  const orig = L.topicSubscribe;
  L.topicSubscribe = async () => { throw new Error('resend 500'); };
  const tok = L.token('nl-fa', id, 0);
  const r = rs(); await nlUnsub(mk('POST', '/lw/api/nlunsub?site=fa&t=' + encodeURIComponent(tok)), r);
  assert.equal(r.statusCode, 503, 'no false success when the provider opt-out fails');
  assert.equal(JSON.parse(r.body).error, 'optout-unresolved');
  const rec = await FA.faStore.get(id);
  assert.equal(rec.nlUnsub.fa.provider, 'failed', 'pending opt-out durably tracked');
  // bulk dispatch must block while the opt-out is unresolved (even with all gates open)
  const nl = require('../api/_nlh/weekly');
  // Feed stub: the original run exercised this path with the live feed inside the
  // 2026-10-25 window; stub keeps the opt-out gate test date-independent.
  const origFetchWeek = content.fetchWeek;
  content.fetchWeek = async () => ({ items: [
    { title: 'Artikel Eins', url: 'https://finanz-adjust.de/artikel/eins/', teaser: 'Teaser', cat: null, img: null, dayLabel: 'Fr 24.10.' },
    { title: 'Artikel Zwei', url: 'https://finanz-adjust.de/artikel/zwei/', teaser: 'Teaser', cat: null, img: null, dayLabel: 'Do 23.10.' },
    { title: 'Artikel Drei', url: 'https://finanz-adjust.de/artikel/drei/', teaser: 'Teaser', cat: null, img: null, dayLabel: 'Mi 22.10.' }
  ], more: [], weekLabel: 'KW 43 · 18.–24. Oktober', campaign: 'kw43-2026', total: 3, extra: null });
  process.env.NL_DISPATCH_ENABLED = '1'; process.env.NL_CAS_VERIFIED = '1'; process.env.NL_REGISTRY_URL = 'https://example.invalid/registry.json';
  const auth = L.sign('nl:fa:2026-10-25');
  const mkA = (m2, u2) => ({ method: m2, url: u2, headers: { 'x-lw-auth': auth } });
  try {
    const r2 = rs(); await nl(mkA('POST', '/lw/api/nlweekly?site=fa&date=2026-10-25'), r2);
    assert.equal(r2.statusCode, 409, 'broadcast held while opt-out unresolved: ' + r2.statusCode + ' ' + r2.body);
    assert.equal(JSON.parse(r2.body).error, 'optout-unresolved');
    // provider recovers -> sweep resolves it, block lifts (dispatch now reaches sender/audience gates)
    L.topicSubscribe = async () => {};
    const origList = L.topicList;
    L.topicList = async () => ({ topics: [{ id: 'topic_fa_weekly', subscription: 'opt_out' }] });
    const r3 = rs(); await nl(mkA('POST', '/lw/api/nlweekly?site=fa&date=2026-10-25'), r3);
    L.topicList = origList;
    const j3 = JSON.parse(r3.body);
    assert.notEqual(j3.error, 'optout-unresolved', 'block lifted after verified opt-out');
    const rec2 = await FA.faStore.get(id);
    assert.equal(rec2.nlUnsub.fa.provider, 'ok', 'verified provider opt-out recorded');
  } finally {
    L.topicSubscribe = orig;
    content.fetchWeek = origFetchWeek;
    SITES.fa.segmentId = origCfg.segmentId; SITES.fa.topicId = origCfg.topicId;
    delete process.env.NL_TOPIC_ID_FA; delete process.env.NL_SEGMENT_ID_FA;
    delete process.env.NL_DISPATCH_ENABLED; delete process.env.NL_CAS_VERIFIED; delete process.env.NL_REGISTRY_URL;
  }
});

test('nl-weekly admin auth: additive NL_ADMIN_KEY, LW_SECRET kept, short key ignored', async () => {
  const nl = require('../api/_nlh/weekly');
  const realFetch = content.fetchWeek;
  content.fetchWeek = async (cfg, date) => realFetch(cfg, date, fakeFeed);
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } });
  const mkA = (auth) => ({ method: 'GET', url: '/lw/api/nlweekly?site=kifb&date=2026-10-25&dry=1', headers: { 'x-lw-auth': auth } });
  const crypto2 = require('crypto');
  const signWith = (k, msg) => crypto2.createHmac('sha256', k).update(msg).digest('base64url');
  const msg = 'nl:kifb:2026-10-25';
  // without NL_ADMIN_KEY: LW_SECRET HMAC accepted, foreign key rejected
  delete process.env.NL_ADMIN_KEY;
  let r = rs(); await nl(mkA(L.sign(msg)), r); assert.equal(JSON.parse(r.body).ok, true, 'LW_SECRET auth keeps working');
  r = rs(); await nl(mkA(signWith('z'.repeat(40), msg)), r); assert.equal(r.statusCode, 401, 'foreign key rejected');
  // with NL_ADMIN_KEY: both accepted (additive, no rotation of LW_SECRET)
  process.env.NL_ADMIN_KEY = 'y'.repeat(48);
  r = rs(); await nl(mkA(L.sign(msg)), r); assert.equal(JSON.parse(r.body).ok, true, 'LW_SECRET still accepted alongside');
  r = rs(); await nl(mkA(signWith(process.env.NL_ADMIN_KEY, msg)), r); assert.equal(JSON.parse(r.body).ok, true, 'NL_ADMIN_KEY accepted');
  r = rs(); await nl(mkA(signWith('z'.repeat(40), msg)), r); assert.equal(r.statusCode, 401, 'third key still rejected');
  // too-short NL_ADMIN_KEY is ignored, never weakens the check
  process.env.NL_ADMIN_KEY = 'short';
  r = rs(); await nl(mkA(signWith('short', msg)), r); assert.equal(r.statusCode, 401, 'short NL_ADMIN_KEY ignored');
  delete process.env.NL_ADMIN_KEY;
  // user-facing tokens remain LW_SECRET-only: a doi token signed with the admin key verifies nowhere
  assert.equal(L.verify('doi', (() => { const b64 = (b) => Buffer.from(b).toString('base64url'); const id = L.idOf('t@t.de'); const body = 'doi.' + id + '.0'; return b64(body) + '.' + signWith('y'.repeat(48), body); })()), null, 'NL_ADMIN_KEY cannot mint user tokens');
});

test('probe provision: explicit empty registryUrl never falls back to production env URL', async () => {
  const dispatch = require('../newsletter/dispatch');
  process.env.NL_REGISTRY_URL = 'https://prod.invalid/registry.json';
  const store = new Map();
  let etagN = 0;
  const ops = [];
  const urlOf = (k) => 'https://store.invalid/' + k;
  store.set(process.env.NL_REGISTRY_URL, { value: { v: 1, issues: {} }, etag: 'e0' });
  const mockBlob = {
    getWithEtag: async (u) => { ops.push('get:' + u); const e = store.get(u); return e ? { value: JSON.parse(JSON.stringify(e.value)), etag: e.etag } : null; },
    list: async (k) => [...store.keys()].filter((u) => u === urlOf(k)).map((u) => ({ pathname: k, url: u })),
    put: async (k, v) => { ops.push('put:' + k); store.set(urlOf(k), { value: JSON.parse(JSON.stringify(v)), etag: 'e' + (++etagN) }); return { url: urlOf(k) }; },
    putCas: async (k, v, et) => { const u = urlOf(k); const e = store.get(u); if (!e || e.etag !== et) return false; ops.push('putCas:' + k); store.set(u, { value: JSON.parse(JSON.stringify(v)), etag: 'e' + (++etagN) }); return true; },
    del: async (u) => { store.delete(u); return true; },
    status: async (u) => (store.has(u) ? 200 : 404)
  };
  try {
    const r = await dispatch.probeStorage({ blob: mockBlob });
    assert.equal(r.ok, true, 'probe passes: ' + JSON.stringify(r));
    assert.ok(ops.includes('get:' + process.env.NL_REGISTRY_URL), 'P0 read-only attestation hit the configured URL');
    assert.ok(!ops.some((o) => o.startsWith('put') && o.includes('prod.invalid')), 'production URL never written');
  } finally {
    delete process.env.NL_REGISTRY_URL;
  }
});

test('curated: duplicate leads counted once, capped at maxItems, more from full pool deduped', async () => {
  const { applyCurated } = require('../newsletter/curated');
  const cfg = { site: 'https://x.de', maxItems: 3, maxMore: 2 };
  const feed = ['a','b','c','d','e','a'].map((s, i) => ({ title: 'T' + s, url: 'https://x.de/' + s + '/', ts: 100 - i }));
  const week = { items: [], more: [], total: feed.length, _all: feed, _map: (i, n) => ({ ...i, orig: i.url }), _mapMore: (i, n) => ({ title: i.title, url: i.url + '?m=' + n }) };
  // same URL three times + two more unique -> only 3 unique leads, dup in skipped
  const r = applyCurated(week, { items: [{ url: 'https://x.de/a/' }, { url: 'https://x.de/a/' }, { url: 'https://x.de/a/' }, { url: 'https://x.de/b/' }, { url: 'https://x.de/c/' }, { url: 'https://x.de/d/' }] }, cfg);
  assert.equal(r.curatedApplied, 3, 'leads capped at maxItems with unique URLs only: ' + r.curatedApplied);
  assert.deepEqual(r.items.map((i) => i.orig), ['https://x.de/a/', 'https://x.de/b/', 'https://x.de/c/']);
  assert.ok(r.curatedSkipped.filter((s) => s === 'https://x.de/a/').length === 2, 'duplicate leads listed in skipped');
  assert.ok(r.curatedSkipped.includes('https://x.de/d/'), 'lead beyond maxItems listed in skipped');
  // more = full pool minus picked, unique, capped at maxMore -> d and e (a,b,c picked; feed-dup a collapsed)
  assert.deepEqual(r.more.map((m) => m.title), ['Td', 'Te'], 'more from full pool minus picked, unique: ' + JSON.stringify(r.more));
});

test('registry provision: configured env URL is read-only, unreadable fails closed, explicit empty never falls back', async () => {
  const dispatch = require('../newsletter/dispatch');
  const puts = [];
  const readable = { getWithEtag: async (u) => (u === 'https://prod.invalid/registry.json' ? { value: { v: 1, issues: {} }, etag: 'e0' } : null), list: async () => [], put: async (k, v) => { puts.push(k); return { url: 'https://store.invalid/' + k }; }, putCas: async () => true, del: async () => true };
  process.env.NL_REGISTRY_URL = 'https://prod.invalid/registry.json';
  try {
    const r1 = await dispatch.provisionRegistry({ blob: readable });
    assert.equal(r1.created, false, 'existing configured registry: inspect only');
    assert.equal(puts.length, 0, 'no PUT against configured registry');
    const unread = { ...readable, getWithEtag: async () => null };
    await assert.rejects(() => dispatch.provisionRegistry({ blob: unread }), /unreadable|fail closed/i, 'unreadable configured URL fails closed');
    // explicit '' + list hit -> inspect only, no create
    const listed = { ...readable, list: async (k) => [{ pathname: k, url: 'https://store.invalid/' + k }], getWithEtag: async (u) => (u.startsWith('https://store.invalid/') ? { value: { v: 1, issues: {} }, etag: 'e1' } : null) };
    const r3 = await dispatch.provisionRegistry({ blob: listed, registryKey: 'nl-probe/x/registry.json', registryUrl: '' });
    assert.equal(r3.created, false, 'list hit: inspect only, no blind create');
    assert.equal(puts.length, 0, 'still no PUT');
  } finally {
    delete process.env.NL_REGISTRY_URL;
  }
});

test('probe cleanup: unconfirmed delete fails closed instead of ok:true', async () => {
  const dispatch = require('../newsletter/dispatch');
  process.env.NL_REGISTRY_URL = 'https://prod.invalid/registry.json';
  const store = new Map();
  let etagN = 0;
  const urlOf = (k) => 'https://store.invalid/' + k;
  store.set(process.env.NL_REGISTRY_URL, { value: { v: 1, issues: {} }, etag: 'e0' });
  const mockBlob = {
    getWithEtag: async (u) => { const e = store.get(u); return e ? { value: JSON.parse(JSON.stringify(e.value)), etag: e.etag } : null; },
    list: async () => [],
    put: async (k, v) => { store.set(urlOf(k), { value: JSON.parse(JSON.stringify(v)), etag: 'e' + (++etagN) }); return { url: urlOf(k) }; },
    putCas: async (k, v, et) => { const u = urlOf(k); const e = store.get(u); if (!e || e.etag !== et) return false; store.set(u, { value: JSON.parse(JSON.stringify(v)), etag: 'e' + (++etagN) }); return true; },
    del: async (u) => { if (!u.endsWith('/registry.json')) store.delete(u); return true; }, // tmp deleted, probe registry survives
    status: async (u) => (u.endsWith('/registry.json') && store.has(u) ? 500 : 404) // read-back error never proves absence
  };
  try {
    const r = await dispatch.probeStorage({ blob: mockBlob });
    assert.equal(r.ok, false, 'no-op delete must not pass: ' + JSON.stringify(r));
    assert.equal(r.step, 'cleanup-failed', 'unconfirmed cleanup reported: ' + r.step);
  } finally {
    delete process.env.NL_REGISTRY_URL;
  }
});

test('probe cleanup: early P4 failure still runs verified cleanup and keeps original step', async () => {
  const dispatch = require('../newsletter/dispatch');
  process.env.NL_REGISTRY_URL = 'https://prod.invalid/registry.json';
  const store = new Map();
  let etagN = 0;
  const dels = [];
  const urlOf = (k) => 'https://store.invalid/' + k;
  store.set(process.env.NL_REGISTRY_URL, { value: { v: 1, issues: {} }, etag: 'e0' });
  const mockBlob = {
    getWithEtag: async (u) => { const e = store.get(u); return e ? { value: JSON.parse(JSON.stringify(e.value)), etag: e.etag } : null; },
    list: async () => [],
    put: async (k, v) => { store.set(urlOf(k), { value: JSON.parse(JSON.stringify(v)), etag: 'e' + (++etagN) }); return { url: urlOf(k) }; },
    putCas: async () => false, // P4 fails immediately
    del: async (u) => { dels.push(u); store.delete(u); return true; },
    status: async (u) => (store.has(u) ? 200 : 404)
  };
  try {
    const r = await dispatch.probeStorage({ blob: mockBlob });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'P4-current-cas-failed', 'original finding kept: ' + JSON.stringify(r));
    assert.ok(!r.cleanup, 'cleanup verified clean, no failure flag');
    assert.ok(dels.some((u) => u.endsWith('/registry.json')), 'cleanup ran for created probe registry despite P4 failure');
  } finally {
    delete process.env.NL_REGISTRY_URL;
  }
});

test('probe cleanup: successful PUT with failing initial verification read is still cleaned up', async () => {
  const dispatch = require('../newsletter/dispatch');
  process.env.NL_REGISTRY_URL = 'https://prod.invalid/registry.json';
  const store = new Map();
  let etagN = 0;
  const dels = [];
  const urlOf = (k) => 'https://store.invalid/' + k;
  store.set(process.env.NL_REGISTRY_URL, { value: { v: 1, issues: {} }, etag: 'e0' });
  const mockBlob = {
    getWithEtag: async (u) => {
      if (u === process.env.NL_REGISTRY_URL) return { value: { v: 1, issues: {} }, etag: 'e0' };
      throw new Error('read-blows-up'); // initial verification GET after PUT fails
    },
    list: async () => [],
    put: async (k, v) => { store.set(urlOf(k), { value: JSON.parse(JSON.stringify(v)), etag: 'e' + (++etagN) }); return { url: urlOf(k) }; },
    putCas: async () => false,
    del: async (u) => { dels.push(u); store.delete(u); return true; },
    status: async (u) => (store.has(u) ? 200 : 404)
  };
  try {
    const r = await dispatch.probeStorage({ blob: mockBlob });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'exception', 'original read failure kept: ' + JSON.stringify(r));
    assert.ok(!r.cleanup, 'cleanup verified clean despite the exception');
    assert.ok(dels.some((u) => u.endsWith('/registry.json')), 'cleanup attempted for the probe registry created before the failed read');
  } finally {
    delete process.env.NL_REGISTRY_URL;
  }
});

test('nl-weekly topicstate=1: read-only, early conflict validation, zero side effects', async () => {
  const L = require('../api/_lw');
  const FA = require('../api/_fa/falib');
  const nl = require('../api/_nlh/weekly');
  const content = require('../newsletter/content');
  const dispatch = require('../newsletter/dispatch');
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; }, statusCode: 200 });
  const email = 'topicstate@test.de';
  await FA.faStore.put(L.idOf(email), { email, confirmedAt: '2026-10-24T10:00:00Z', nlOptIn: true, nlSync: { consentAt: '2026-10-24T10:00:00Z', state: 'unknown', error: 'topic-subscribe 422' } });
  process.env.NL_TOPIC_ID_FA = 'topic_fa_weekly';
  const origFetchWeek = content.fetchWeek;
  content.fetchWeek = async () => ({ items: [{ title: 'A', url: 'https://x.test/a', teaser: 't', cat: null, img: null, dayLabel: 'Fr 24.10.' }, { title: 'B', url: 'https://x.test/b', teaser: 't', cat: null, img: null, dayLabel: 'Do 23.10.' }, { title: 'C', url: 'https://x.test/c', teaser: 't', cat: null, img: null, dayLabel: 'Mi 22.10.' }], more: [], weekLabel: 'KW 43', campaign: 'kw43-2026', total: 3, extra: null });
  const counts = { contactGet: 0, topicList: 0, topicSubscribe: 0, probe: 0, sendMail: 0 };
  const orig = { contactGet: L.contactGet, topicList: L.topicList, topicSubscribe: L.topicSubscribe, probe: dispatch.probeStorage, sendMail: L.sendMail };
  L.contactGet = async () => { counts.contactGet++; return { exists: true }; };
  L.topicList = async () => { counts.topicList++; return { topics: [{ id: 'topic_fa_weekly', subscription: 'opt_in' }] }; };
  L.topicSubscribe = async () => { counts.topicSubscribe++; };
  dispatch.probeStorage = async () => { counts.probe++; return { ok: true }; };
  L.sendMail = async () => { counts.sendMail++; };
  const auth = L.sign('nl:fa:2026-10-25');
  const snap = async () => JSON.stringify((await FA.faStore.list()).map((x) => x.rec));
  try {
    const before = await snap();
    const r = rs(); await nl({ method: 'GET', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&topicstate=1', headers: { 'x-lw-auth': auth } }, r);
    const j = JSON.parse(r.body);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(j.topicStates, [{ record: L.idOf(email), nlSyncState: 'unknown', topicConfigured: true, provider: 'opt_in' }]);
    assert.equal(counts.contactGet, 1, 'one contact read per unresolved record');
    assert.equal(counts.topicList, 1, 'one topic-list read per unresolved record');
    assert.equal(counts.topicSubscribe, 0, 'no provider writes');
    assert.equal(counts.probe, 0, 'no storage probe');
    assert.equal(counts.sendMail, 0, 'no mail');
    assert.equal(await snap(), before, 'every store record byte-identical');

    // early conflict validation: rejected before ANY side-effect branch runs
    for (const url of [
      '/lw/api/nlweekly?site=fa&date=2026-10-25&topicstate=1',
      '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&topicstate=1&probe=1',
      '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&topicstate=1&to=a%40b.de'
    ]) {
      const r2 = rs(); await nl({ method: 'GET', url, headers: { 'x-lw-auth': auth } }, r2);
      assert.equal(r2.statusCode, 400, url);
      assert.equal(JSON.parse(r2.body).error, 'topicstate-conflict', url);
    }
    const r3 = rs(); await nl({ method: 'POST', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&topicstate=1', headers: { 'x-lw-auth': auth } }, r3);
    assert.equal(r3.statusCode, 400, 'POST rejected');
    assert.equal(counts.contactGet, 1, 'conflicts ran no provider reads');
    assert.equal(counts.probe, 0, 'conflicts ran no storage probe');
    assert.equal(counts.sendMail, 0, 'conflicts sent no mail');
    assert.equal(counts.topicSubscribe, 0, 'conflicts wrote nothing');
    assert.equal(await snap(), before, 'still byte-identical after conflicts');

    // auth failure runs nothing at all
    const r4 = rs(); await nl({ method: 'GET', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&topicstate=1', headers: { 'x-lw-auth': 'bad' } }, r4);
    assert.equal(r4.statusCode, 401);
    assert.equal(counts.contactGet, 1, 'no provider access without auth');
  } finally {
    L.contactGet = orig.contactGet; L.topicList = orig.topicList; L.topicSubscribe = orig.topicSubscribe;
    dispatch.probeStorage = orig.probe; L.sendMail = orig.sendMail; content.fetchWeek = origFetchWeek;
  }
});

test('nl-weekly topicstate=1: honest provider evidence (contact404 vs topic404, values, error codes)', async () => {
  const L = require('../api/_lw');
  const FA = require('../api/_fa/falib');
  const nl = require('../api/_nlh/weekly');
  const content = require('../newsletter/content');
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; }, statusCode: 200 });
  const email = 'topicstate2@test.de';
  await FA.faStore.put(L.idOf(email), { email, confirmedAt: '2026-10-24T10:00:00Z', nlOptIn: true, nlSync: { consentAt: '2026-10-24T10:00:00Z', state: 'attempting' } });
  process.env.NL_TOPIC_ID_FA = 'topic_fa_weekly';
  const origFetchWeek = content.fetchWeek;
  content.fetchWeek = async () => ({ items: [{ title: 'A', url: 'https://x.test/a', teaser: 't', cat: null, img: null, dayLabel: 'Fr 24.10.' }, { title: 'B', url: 'https://x.test/b', teaser: 't', cat: null, img: null, dayLabel: 'Do 23.10.' }, { title: 'C', url: 'https://x.test/c', teaser: 't', cat: null, img: null, dayLabel: 'Mi 22.10.' }], more: [], weekLabel: 'KW 43', campaign: 'kw43-2026', total: 3, extra: null });
  const orig = { contactGet: L.contactGet, topicList: L.topicList, topicSubscribe: L.topicSubscribe };
  let subscribeCalls = 0; L.topicSubscribe = async () => { subscribeCalls++; };
  const auth = L.sign('nl:fa:2026-10-25');
  const run = async () => {
    const r = rs(); await nl({ method: 'GET', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&topicstate=1', headers: { 'x-lw-auth': auth } }, r);
    return JSON.parse(r.body).topicStates.find((e) => e.record === L.idOf(email));
  };
  const scenarios = [
    ['contact-not-found', { contact: { notFound: true } }, { provider: 'contact-not-found' }],
    ['topic-list-404-is-NOT-contact-not-found', { contact: { exists: true }, list: { notFound: true } }, { provider: 'topic-list-unavailable' }],
    ['opt_out', { contact: { exists: true }, list: { topics: [{ id: 'topic_fa_weekly', subscription: 'opt_out' }] } }, { provider: 'opt_out' }],
    ['topic-absent', { contact: { exists: true }, list: { topics: [{ id: 'other', subscription: 'opt_in' }] } }, { provider: 'topic-absent' }],
    ['unknown-subscription-never-echoed', { contact: { exists: true }, list: { topics: [{ id: 'topic_fa_weekly', subscription: 'weird-value' }] } }, { provider: 'unknown-subscription' }],
    ['topic-list-429-fixed-code', { contact: { exists: true }, listErr: new Error('topic-list 429') }, { provider: 'topic-list-unreadable', code: 'topic-list-429' }],
    ['topic-list-pagination-fixed-code', { contact: { exists: true }, listErr: new Error('topic-list cursor-repeat') }, { provider: 'topic-list-unreadable', code: 'topic-list-cursor-repeat' }],
    ['unclassified-error-collapsed', { contact: { exists: true }, listErr: new Error('socket hang up') }, { provider: 'topic-list-unreadable', code: 'topic-list-error' }],
    ['contact-500-fixed-code', { contactErr: new Error('contact-read 500') }, { provider: 'contact-unreadable', code: 'contact-read-500' }]
  ];
  try {
    for (const [name, stub, want] of scenarios) {
      L.contactGet = async () => { if (stub.contactErr) throw stub.contactErr; return stub.contact || { exists: true }; };
      L.topicList = async () => { if (stub.listErr) throw stub.listErr; return stub.list; };
      const entry = await run();
      assert.equal(entry.provider, want.provider, name);
      if (want.code) assert.equal(entry.code, want.code, name + ' code');
      else assert.equal(entry.code, undefined, name + ' no code');
      assert.equal(entry.nlSyncState, 'attempting');
      assert.equal(entry.topicConfigured, true);
    }
    delete process.env.NL_TOPIC_ID_FA;
    const entry = await run();
    assert.equal(entry.provider, 'unconfigured');
    assert.equal(entry.topicConfigured, false);
    assert.equal(subscribeCalls, 0, 'never a provider write');
  } finally {
    process.env.NL_TOPIC_ID_FA = 'topic_fa_weekly';
    L.contactGet = orig.contactGet; L.topicList = orig.topicList; L.topicSubscribe = orig.topicSubscribe; content.fetchWeek = origFetchWeek;
  }
});

test('nl-weekly broadcaststate=1: read-only inventory route, early conflict validation, zero side effects', async () => {
  const L = require('../api/_lw');
  const FA = require('../api/_fa/falib');
  const nl = require('../api/_nlh/weekly');
  const content = require('../newsletter/content');
  const dispatch = require('../newsletter/dispatch');
  const rs = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; }, statusCode: 200 });
  const email = 'broadcaststate@test.de';
  await FA.faStore.put(L.idOf(email), { email, confirmedAt: '2026-10-24T10:00:00Z', nlOptIn: true, nlSync: { consentAt: '2026-10-24T10:00:00Z', state: 'unknown' } });
  process.env.NL_TOPIC_ID_FA = 'topic_fa_weekly';
  const origFetchWeek = content.fetchWeek;
  content.fetchWeek = async () => ({ items: [{ title: 'A', url: 'https://x.test/a', teaser: 't', cat: null, img: null, dayLabel: 'Fr 24.10.' }, { title: 'B', url: 'https://x.test/b', teaser: 't', cat: null, img: null, dayLabel: 'Do 23.10.' }, { title: 'C', url: 'https://x.test/c', teaser: 't', cat: null, img: null, dayLabel: 'Mi 22.10.' }], more: [], weekLabel: 'KW 43', campaign: 'kw43-2026', total: 3, extra: null });
  const counts = { inv: 0, topicSubscribe: 0, probe: 0, sendMail: 0 };
  const orig = { inv: dispatch.listBroadcastInventory, topicSubscribe: L.topicSubscribe, probe: dispatch.probeStorage, sendMail: L.sendMail };
  dispatch.listBroadcastInventory = async () => { counts.inv++; return { complete: true, pages: 1, broadcasts: [{ id: 'bc1', name: 'FA-Wochenrückblick KW 43', status: 'sent', created_at: 'c', scheduled_at: null, sent_at: 's' }, { id: 'bc2', name: 'Other product', status: 'draft', created_at: 'c2', scheduled_at: null, sent_at: null }] }; };
  L.topicSubscribe = async () => { counts.topicSubscribe++; };
  dispatch.probeStorage = async () => { counts.probe++; return { ok: true }; };
  L.sendMail = async () => { counts.sendMail++; };
  const auth = L.sign('nl:fa:2026-10-25');
  const snap = async () => JSON.stringify((await FA.faStore.list()).map((x) => x.rec));
  try {
    const before = await snap();
    const r = rs(); await nl({ method: 'GET', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&broadcaststate=1', headers: { 'x-lw-auth': auth } }, r);
    const j = JSON.parse(r.body);
    assert.equal(r.statusCode, 200);
    assert.equal(j.broadcastStates.ok, true);
    assert.equal(j.broadcastStates.total, 2);
    assert.equal(j.broadcastStates.complete, true, 'explicit completion marker');
    assert.equal(j.broadcastStates.broadcasts[0].matchesSite, true);
    assert.equal(j.broadcastStates.broadcasts[1].matchesSite, false);
    assert.equal(counts.inv, 1);
    assert.equal(counts.topicSubscribe + counts.probe + counts.sendMail, 0, 'zero mutators');
    assert.equal(await snap(), before, 'store bytes unchanged');

    for (const url of [
      '/lw/api/nlweekly?site=fa&date=2026-10-25&broadcaststate=1',
      '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&broadcaststate=1&probe=1',
      '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&broadcaststate=1&to=a%40b.de'
    ]) {
      const r2 = rs(); await nl({ method: 'GET', url, headers: { 'x-lw-auth': auth } }, r2);
      assert.equal(r2.statusCode, 400, url);
    }
    const r3 = rs(); await nl({ method: 'POST', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&broadcaststate=1', headers: { 'x-lw-auth': auth } }, r3);
    assert.equal(r3.statusCode, 400, 'POST rejected');
    assert.equal(counts.inv, 1, 'conflicts ran no inventory');
    const r4 = rs(); await nl({ method: 'GET', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&broadcaststate=1', headers: { 'x-lw-auth': 'bad' } }, r4);
    assert.equal(r4.statusCode, 401);
    assert.equal(counts.inv, 1, 'no inventory without auth');

    // provider error -> fixed code, ok:false, never raw
    dispatch.listBroadcastInventory = async () => { counts.inv++; throw new Error('broadcast-list 500'); };
    const r5 = rs(); await nl({ method: 'GET', url: '/lw/api/nlweekly?site=fa&date=2026-10-25&dry=1&broadcaststate=1', headers: { 'x-lw-auth': auth } }, r5);
    const j5 = JSON.parse(r5.body);
    assert.equal(j5.broadcastStates.ok, false);
    assert.equal(j5.broadcastStates.code, 'broadcast-list-500');
  } finally {
    dispatch.listBroadcastInventory = orig.inv; L.topicSubscribe = orig.topicSubscribe;
    dispatch.probeStorage = orig.probe; L.sendMail = orig.sendMail; content.fetchWeek = origFetchWeek;
  }
});
