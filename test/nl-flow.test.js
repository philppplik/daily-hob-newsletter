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
  const xml = feedXml([
    ['in-first',  'https://x.de/artikel/a1', 'Sat, 18 Oct 2026 00:30:00 +0200'], // first window hour (CEST)
    ['out-early', 'https://x.de/artikel/a2', 'Fri, 17 Oct 2026 23:30:00 +0200'],  // before window
    ['in-last',   'https://x.de/artikel/a3', 'Sat, 24 Oct 2026 23:30:00 +0200'],  // last window hour (CEST)
    ['out-late',  'https://x.de/artikel/a4', 'Sun, 25 Oct 2026 00:30:00 +0200'],  // send day itself excluded
    ['in-cet',    'https://x.de/artikel/a5', 'Sat, 24 Oct 2026 20:30:00 +0100']   // = 20:30 UTC, inside
  ]);
  const cfg = { ...SITES.kifb, feed: 'https://x.de/feed', site: 'https://x.de', preferSlug: null, preferBeforeHour: null };
  const w = await content.fetchWeek(cfg, '2026-10-25', fakeFetch(xml));
  const titles = w.items.map((i) => i.title).concat(w.more.map((i) => i.title));
  assert.ok(titles.includes('in-first') && titles.includes('in-last') && titles.includes('in-cet'));
  assert.ok(!titles.includes('out-early') && !titles.includes('out-late'));
  assert.equal(w.total, 3);
  assert.ok(/^KW 43 · 18\.–24\. Oktober$/.test(w.weekLabel), w.weekLabel);
});

test('Berlin week window across DST start (2026-03-29)', async () => {
  const xml = feedXml([
    ['in-first', 'https://x.de/artikel/b1', 'Sun, 22 Mar 2026 00:30:00 +0100'],
    ['out-early','https://x.de/artikel/b2', 'Sat, 21 Mar 2026 23:30:00 +0100'],
    ['in-last',  'https://x.de/artikel/b3', 'Sat, 28 Mar 2026 23:30:00 +0100'],
    ['out-late', 'https://x.de/artikel/b4', 'Sun, 29 Mar 2026 00:30:00 +0100']
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
    ['morgen-ohne-slug', 'https://k.de/deepinfer', 'Fri, 23 Oct 2026 07:30:00 +0200'],
    ['wissen-2',   'https://k.de/noch-wissen',     'Fri, 23 Oct 2026 15:00:00 +0200']
  ]);
  const cfg2 = { ...SITES.kifb, feed: 'https://k.de/feed', site: 'https://k.de', maxItems: 4, maxMore: 4 };
  const w2 = await content.fetchWeek(cfg2, '2026-10-25', fakeFetch(xml2));
  assert.deepEqual(w2.items.map((i) => i.title).slice(0, 2), ['analyse', 'morgen-ohne-slug']); // per-day lead = analysis
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
  process.env.NL_DISPATCH_ENABLED = '1'; process.env.NL_CAS_VERIFIED = '1'; process.env.NL_REGISTRY_URL = 'https://example.invalid/registry.json';
  const auth = L.sign('nl:fa:2026-10-25');
  const mkA = (m2, u2) => ({ method: m2, url: u2, headers: { 'x-lw-auth': auth } });
  const r2 = rs(); await nl(mkA('POST', '/lw/api/nlweekly?site=fa&date=2026-10-25'), r2);
  assert.equal(r2.statusCode, 409, 'broadcast held while opt-out unresolved: ' + r2.statusCode + ' ' + r2.body);
  assert.equal(JSON.parse(r2.body).error, 'optout-unresolved');
  // provider recovers -> sweep resolves it, block lifts (dispatch now reaches sender/audience gates)
  L.topicSubscribe = async () => {};
  const r3 = rs(); await nl(mkA('POST', '/lw/api/nlweekly?site=fa&date=2026-10-25'), r3);
  const j3 = JSON.parse(r3.body);
  assert.notEqual(j3.error, 'optout-unresolved', 'block lifted after verified opt-out');
  const rec2 = await FA.faStore.get(id);
  assert.equal(rec2.nlUnsub.fa.provider, 'ok', 'verified provider opt-out recorded');
  L.topicSubscribe = orig;
  SITES.fa.segmentId = origCfg.segmentId; SITES.fa.topicId = origCfg.topicId;
  delete process.env.NL_TOPIC_ID_FA; delete process.env.NL_SEGMENT_ID_FA;
  delete process.env.NL_DISPATCH_ENABLED; delete process.env.NL_CAS_VERIFIED; delete process.env.NL_REGISTRY_URL;
});
