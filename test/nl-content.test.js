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
