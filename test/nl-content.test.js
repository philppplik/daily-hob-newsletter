const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed } = require('../newsletter/content');

test('parseFeed decodes numeric hex + decimal entities (Moody&#x27;s bug)', () => {
  const xml = `<rss><channel>
    <item><title>Moody&#x27;s senkt Rating</title><link>https://finanz-adjust.de/artikel/moodys/</link><pubDate>Fri, 23 Oct 2026 09:00:00 +0200</pubDate><description>Kurz &#38; knapp&#8211;Update</description></item>
    <item><title>Apple &amp; Co &#x2013; Woche</title><link>https://finanz-adjust.de/artikel/apple/</link><pubDate>Thu, 22 Oct 2026 09:00:00 +0200</pubDate><description>Teaser</description></item>
  </channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Moody's senkt Rating");
  assert.ok(items[0].teaser.startsWith('Kurz & knapp'));
  assert.equal(items[1].title, 'Apple & Co – Woche');
  for (const i of items) assert.ok(!/&#x?[0-9a-fA-F]+;|&(amp|lt|gt|quot|apos);/.test(i.title + ' ' + i.teaser), 'no raw entities survive');
});

const { fetchWeek } = require('../newsletter/content');
const { applyCurated } = require('../newsletter/curated');
const { SITES } = require('../newsletter/config');
const feedOf = (xml) => async () => ({ ok: true, text: async () => xml });

test('fetchWeek: Fenster von Stichtag zu Stichtag (Fr 09:00) - lueckenlos, ohne Duplikate', async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>FA</title>
  <item><title>Vor Stichtag alt</title><link>https://finanz-adjust.de/artikel/vor-alt/</link><pubDate>Fri, 20 Nov 2026 08:30:00 +0100</pubDate><description>a</description></item>
  <item><title>Nachsendung Vorwoche</title><link>https://finanz-adjust.de/artikel/nachsendung/</link><pubDate>Fri, 20 Nov 2026 18:00:00 +0100</pubDate><description>b</description></item>
  <item><title>Samstag Start</title><link>https://finanz-adjust.de/artikel/samstag/</link><pubDate>Sat, 21 Nov 2026 08:00:00 +0100</pubDate><description>c</description></item>
  <item><title>Freitag frueh</title><link>https://finanz-adjust.de/artikel/freitag/</link><pubDate>Fri, 27 Nov 2026 06:30:00 +0100</pubDate><description>d</description></item>
  <item><title>Nach Stichtag</title><link>https://finanz-adjust.de/artikel/nach-stichtag/</link><pubDate>Fri, 27 Nov 2026 10:00:00 +0100</pubDate><description>e</description></item>
  <item><title>Naechste Woche</title><link>https://finanz-adjust.de/artikel/naechste/</link><pubDate>Sat, 28 Nov 2026 00:30:00 +0100</pubDate><description>f</description></item>
  </channel></rss>`;
  const w = await fetchWeek(SITES.fa, '2026-11-27', feedOf(xml));
  assert.equal(w.weekLabel, 'KW 48 · 20.–27. November');
  assert.deepEqual(w.items.map((i) => i.orig).sort(), [
    'https://finanz-adjust.de/artikel/freitag/',
    'https://finanz-adjust.de/artikel/nachsendung/',
    'https://finanz-adjust.de/artikel/samstag/'
  ], 'Fenster [Fr 20.11. 09:00, Fr 27.11. 09:00): Nachsendung der Vorwoche und Freitagmorgen sind dabei');
  const freitag = w.items.find((i) => i.orig.endsWith('/freitag/'));
  assert.match(freitag.url, /utm_campaign=kw48-2026/);
  // Lueckenlos ohne Duplikate: die naechste Ausgabe beginnt exakt am Stichtag
  const wNext = await fetchWeek(SITES.fa, '2026-12-04', feedOf(xml));
  assert.deepEqual(wNext.items.map((i) => i.orig).sort(), [
    'https://finanz-adjust.de/artikel/nach-stichtag/',
    'https://finanz-adjust.de/artikel/naechste/'
  ], 'Folgeausgabe [Fr 27.11. 09:00, Fr 04.12. 09:00) nimmt den Rest mit, nichts doppelt');
  assert.equal(wNext.weekLabel, 'KW 49 · 27. November–4. Dezember');
});

test('fetchWeek: cfg.imgLabelDefault marks own heroes; no image -> no label; kifb has no default', async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>FA</title>
  <item><title>Mit Bild</title><link>https://finanz-adjust.de/artikel/mitbild/</link><pubDate>Fri, 27 Nov 2026 06:30:00 +0100</pubDate><description>c</description><media:content url="https://finanz-adjust.de/assets/hero.jpg"/></item>
  <item><title>Ohne Bild</title><link>https://finanz-adjust.de/artikel/ohnebild/</link><pubDate>Thu, 26 Nov 2026 09:00:00 +0100</pubDate><description>d</description></item>
  </channel></rss>`;
  const w = await fetchWeek(SITES.fa, '2026-11-27', feedOf(xml));
  assert.equal(w.items[0].img, 'https://finanz-adjust.de/assets/hero.jpg');
  assert.equal(w.items[0].imgLabel, 'KI-generierte Symbolgrafik · Symbolbild', 'FA-Defaultmarkierung am eigenen Hero');
  assert.equal(w.items[1].img, null);
  assert.equal(w.items[1].imgLabel, null, 'keine Markierung ohne Bild');
  const xmlK = xml.replaceAll('finanz-adjust.de/artikel', 'kifachblatt.de/artikel').replace('finanz-adjust.de/assets', 'kifachblatt.de/assets');
  const wk = await fetchWeek(SITES.kifb, '2026-11-27', feedOf(xmlK));
  assert.ok(wk.items[0].img, 'kifb hero vorhanden');
  assert.equal(wk.items[0].imgLabel, null, 'kifb ohne Default: Markierung bleibt der Kuratierung vorbehalten');
  // Kuratiertes imgLabel schlaegt den Default
  const out = applyCurated(w, { items: [{ url: 'https://finanz-adjust.de/artikel/mitbild/', imgLabel: 'Redaktionelle Grafik' }] }, SITES.fa);
  assert.equal(out.items[0].imgLabel, 'Redaktionelle Grafik');
  // img 'none' entfernt Bild UND Markierung
  const out2 = applyCurated(w, { items: [{ url: 'https://finanz-adjust.de/artikel/mitbild/', img: 'none' }] }, SITES.fa);
  assert.equal(out2.items[0].img, null);
  assert.ok(!out2.items[0].imgLabel, 'keine Markierung nach img:none');
});
