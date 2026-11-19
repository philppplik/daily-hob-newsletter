'use strict';
// Article images + logo placement in the weekly template (freigegebene Gestaltung:
// Site-Logo oben und unten, ein Beitragsbild je Artikel aus dem eigenen Feed).
process.env.LW_SECRET = 'x'.repeat(40); process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry'; process.env.API_URL = 'https://api.test';
const test = require('node:test'); const assert = require('node:assert');
const { parseFeed, fetchWeek } = require('../newsletter/content');
const { render } = require('../newsletter/template');
const { SITES } = require('../newsletter/config');

test('parseFeed extracts the first media:content url (self-closing, both spacings)', () => {
  const xml = `<rss><channel>
    <item><title>Mit Bild</title><link>https://kifachblatt.de/a</link><pubDate>Thu, 19 Nov 2026 09:00:00 +0100</pubDate><description>t</description><media:content url="https://kifachblatt.de/assets/articles/a.jpg" medium="image" /></item>
    <item><title>Auch Bild</title><link>https://kifachblatt.de/b</link><pubDate>Thu, 19 Nov 2026 08:00:00 +0100</pubDate><description>t</description><media:content url="https://kifachblatt.de/assets/articles/b.jpg" medium="image"/></item>
    <item><title>Ohne Bild</title><link>https://kifachblatt.de/c</link><pubDate>Thu, 19 Nov 2026 07:00:00 +0100</pubDate><description>t</description></item>
  </channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items[0].img, 'https://kifachblatt.de/assets/articles/a.jpg');
  assert.equal(items[1].img, 'https://kifachblatt.de/assets/articles/b.jpg');
  assert.equal(items[2].img, null);
});

test('fetchWeek keeps only same-origin article images', async () => {
  const feed = `<rss><channel>
    <item><title>Eins</title><link>https://kifachblatt.de/eins-analyse</link><pubDate>Sat, 24 Oct 2026 07:00:00 +0200</pubDate><description>t</description><media:content url="https://kifachblatt.de/assets/articles/eins.jpg" medium="image"/></item>
    <item><title>Zwei</title><link>https://kifachblatt.de/zwei-analyse</link><pubDate>Fri, 23 Oct 2026 07:00:00 +0200</pubDate><description>t</description><media:content url="https://cdn.example.com/tracking.gif" medium="image"/></item>
    <item><title>Drei</title><link>https://kifachblatt.de/drei-analyse</link><pubDate>Thu, 22 Oct 2026 07:00:00 +0200</pubDate><description>t</description></item>
  </channel></rss>`;
  const w = await fetchWeek(SITES.kifb, '2026-10-25', async () => ({ ok: true, text: async () => feed }));
  assert.equal(w.items.length, 3);
  assert.equal(w.items[0].img, 'https://kifachblatt.de/assets/articles/eins.jpg', 'own hero kept');
  assert.equal(w.items[1].img, null, 'cross-origin image dropped');
  assert.equal(w.items[2].img, null, 'missing image stays empty');
});

test('render places the article image above its copy and links it to the article', () => {
  const cfg = SITES.kifb;
  const items = [
    { title: 'Held "Zitat"', url: 'https://kifachblatt.de/x?utm_source=t', teaser: 'Teaser', cat: 'Modelle', img: 'https://kifachblatt.de/assets/articles/x.jpg', dayLabel: 'Do 19.11.' },
    { title: 'Ohne Bild', url: 'https://kifachblatt.de/y?utm_source=t', teaser: 'Teaser', cat: null, img: null, dayLabel: 'Mi 18.11.' }
  ];
  const { html, text } = render({ cfg, subject: 'S', preheader: 'P', weekLabel: 'KW 47', items, more: [], unsubUrl: 'https://api.test/lw/api/nlunsub?site=kifb&t=tok' });
  const imgTag = html.match(/<img src="https:\/\/kifachblatt\.de\/assets\/articles\/x\.jpg"[^>]*>/);
  assert.ok(imgTag, 'article image rendered');
  assert.ok(imgTag[0].includes('alt="Held &quot;Zitat&quot;"'), 'alt text escaped');
  assert.ok(imgTag[0].includes('width="208"'), 'fixed attribute width for desktop clients');
  const imgPos = html.indexOf('/assets/articles/x.jpg');
  const titlePos = html.indexOf('Held &quot;Zitat&quot;</a>');
  assert.ok(imgPos > -1 && titlePos > -1 && imgPos < titlePos, 'image beside/above the item title');
  assert.ok(html.includes('class="nl-imgcol"'), 'two-column article layout');
  assert.ok(html.includes('@media only screen and (max-width:520px)'), 'mobile stacking media query');
  const cap = render({ cfg, subject: 'S', preheader: 'P', weekLabel: 'KW 47', items: [{ ...items[0], imgLabel: 'KI-Illustration · Symbolbild' }], more: [], unsubUrl: 'u' });
  assert.ok(cap.html.includes('KI-Illustration · Symbolbild'), 'symbolic illustration visibly marked');
  assert.equal((html.match(/assets\/articles\/x\.jpg/g) || []).length, 1, 'image appears once');
  assert.ok(!html.includes('tracking'), 'no tracking imagery');
  assert.ok(!text.includes('x.jpg'), 'plain-text part unchanged by imagery');
});

test('render shows the site logo in header AND footer (wordmark for FA)', () => {
  const items = [{ title: 'A', url: 'https://kifachblatt.de/a', teaser: '', cat: null, img: null, dayLabel: '' }];
  const kifb = render({ cfg: SITES.kifb, subject: 'S', preheader: 'P', weekLabel: 'W', items, more: [], unsubUrl: 'u' });
  assert.equal((kifb.html.match(/logo-192\.png/g) || []).length, 2, 'KIFB logo top and bottom');
  const fa = render({ cfg: { ...SITES.fa, from: 'finanz adjust <finanz-adjust@hob.philipp-paulik.de>' }, subject: 'S', preheader: 'P', weekLabel: 'W', items, more: [], unsubUrl: 'u' });
  assert.equal((fa.html.match(/finanz /g) || []).length >= 2, true, 'FA wordmark rendered in header and footer');
});

test('applyCurated selects/orders only feed URLs, re-images with label, fail-safe skips', () => {
  const { applyCurated } = require('../newsletter/curated');
  const week = { items: [
    { title: 'A', url: 'https://kifachblatt.de/a?utm_source=x', orig: 'https://kifachblatt.de/a', img: 'https://kifachblatt.de/a.jpg', teaser: '', cat: null, dayLabel: '' },
    { title: 'B', url: 'https://kifachblatt.de/b?utm_source=x', orig: 'https://kifachblatt.de/b', img: 'https://kifachblatt.de/b.jpg', teaser: '', cat: null, dayLabel: '' },
    { title: 'C', url: 'https://kifachblatt.de/c?utm_source=x', orig: 'https://kifachblatt.de/c', img: null, teaser: '', cat: null, dayLabel: '' }
  ], more: [{ title: 'M', url: 'https://kifachblatt.de/m' }], weekLabel: 'W', total: 4, extra: null };
  const cfg = SITES.kifb;
  const out = applyCurated(week, { items: [
    { url: 'https://kifachblatt.de/c' },
    { url: 'https://kifachblatt.de/a', img: 'https://kifachblatt.de/assets/symbol/modell.jpg', imgLabel: 'KI-Illustration · Symbolbild' },
    { url: 'https://kifachblatt.de/b', img: 'none' },
    { url: 'https://kifachblatt.de/nicht-im-feed' },
    { url: 'https://boese.example/phishing' }
  ] }, cfg);
  assert.deepEqual(out.items.map((i) => i.title), ['C', 'A', 'B'], 'curated order, max feed items only');
  assert.equal(out.items[1].img, 'https://kifachblatt.de/assets/symbol/modell.jpg', 'own symbolic override kept');
  assert.equal(out.items[1].imgLabel, 'KI-Illustration · Symbolbild', 'visible symbolic mark carried');
  assert.equal(out.items[2].img, null, 'img none suppresses the hero');
  assert.deepEqual(out.curatedSkipped, ['https://kifachblatt.de/nicht-im-feed', 'https://boese.example/phishing'], 'foreign/unknown URLs skipped, never sent');
  assert.equal(out.more.length, 1, 'more list preserved');
});

test('applyCurated rejects cross-origin image overrides', () => {
  const { applyCurated } = require('../newsletter/curated');
  const week = { items: [{ title: 'A', url: 'u', orig: 'https://kifachblatt.de/a', img: 'https://kifachblatt.de/a.jpg', teaser: '', cat: null, dayLabel: '' }], more: [], weekLabel: 'W', total: 1, extra: null };
  const out = applyCurated(week, { items: [{ url: 'https://kifachblatt.de/a', img: 'https://cdn.evil.example/x.gif', imgLabel: 'KI-Illustration · Symbolbild' }] }, SITES.kifb);
  assert.equal(out.items[0].img, null, 'cross-origin override dropped');
  assert.ok(!out.items[0].imgLabel, 'no label without an image');
});

test('deStale resolves relative day words against the send day', async () => {
  const feed = `<rss><channel>
    <item><title>Nasdaq-Start für heute erwartet</title><link>https://intelligenz-welt.de/artikel/ipo/</link><pubDate>Thu, 19 Nov 2026 08:00:00 +0100</pubDate><description>Die Notierung soll heute kommen, gestern gab es den Preis, morgen der Handel.</description><category>Markt</category></item>
    <item><title>Dritter</title><link>https://intelligenz-welt.de/artikel/drei/</link><pubDate>Wed, 18 Nov 2026 07:00:00 +0100</pubDate><description>t</description></item>
  </channel></rss>`;
  const w = await fetchWeek(SITES.iw, '2026-11-20', async () => ({ ok: true, text: async () => feed }));
  const ipo = w.items.find((i) => i.orig === 'https://intelligenz-welt.de/artikel/ipo/');
  assert.equal(ipo.title, 'Nasdaq-Start für Donnerstag erwartet', 'stale heute -> weekday of the article day');
  assert.equal(ipo.teaser, 'Die Notierung soll Donnerstag kommen, Mittwoch gab es den Preis, Freitag der Handel.', 'gestern/morgen resolved relative to article day');
  const feed2 = `<rss><channel>
    <item><title>KI am Morgen: Neues</title><link>https://intelligenz-welt.de/artikel/morgen/</link><pubDate>Thu, 19 Nov 2026 08:00:00 +0100</pubDate><description>t</description></item>
    <item><title>Morgenüberblick: Kurse</title><link>https://intelligenz-welt.de/artikel/ueberblick/</link><pubDate>Thu, 19 Nov 2026 07:00:00 +0100</pubDate><description>t</description></item>
    <item><title>Heute beginnt der Handel</title><link>https://intelligenz-welt.de/artikel/handel/</link><pubDate>Thu, 19 Nov 2026 06:00:00 +0100</pubDate><description>t</description></item>
  </channel></rss>`;
  const w2 = await fetchWeek(SITES.iw, '2026-11-20', async () => ({ ok: true, text: async () => feed2 }));
  const t = w2.items.map((i) => i.title);
  assert.ok(t.includes('KI am Morgen: Neues'), 'noun Morgen untouched');
  assert.ok(t.includes('Morgenüberblick: Kurse'), 'compound Morgenüberblick untouched');
  assert.ok(t.includes('Donnerstag beginnt der Handel'), 'capitalized adverb at start resolved');
});
