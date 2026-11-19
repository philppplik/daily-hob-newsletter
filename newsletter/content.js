'use strict';
// Weekly content from each site's own public RSS feed (feed.xml). Decoupled by design:
// the newsletter backend never reads the site repos, only the live public feeds.
const unesc = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#x([0-9a-fA-F]{2,6});/g, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d{1,7});/g, (m, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => unesc(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>')); return m ? m[1].trim() : ''; };
// First <media:content url="..."/> (self-closing, namespaced) carries the article hero image.
const mediaImg = (block) => { const m = block.match(/<media:content\b[^>]*?\burl="([^"]+)"[^>]*?\/?>/); return m ? m[1].trim() : ''; };

function parseFeed(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const ts = Date.parse(tag(b, 'pubDate'));
    items.push({ title: stripTags(tag(b, 'title')), url: stripTags(tag(b, 'link')), teaser: ((t) => (t.length <= 220 ? t : t.slice(0, 220).replace(/\s+\S*$/, '') + '…'))(stripTags(tag(b, 'description'))), cat: stripTags(tag(b, 'category')) || null, img: mediaImg(b) || null, ts });
  }
  return items.filter((i) => i.title && i.url && !isNaN(i.ts));
}

// Berlin wall-clock helpers (send day and week window are Europe/Berlin dates).
function berlinOffsetMs(d) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of dtf.formatToParts(d)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime();
}
function berlinMidnightUtc(dateStr) {
  const guess = Date.parse(dateStr + 'T00:00:00Z');
  return guess - berlinOffsetMs(new Date(guess));
}
const dayFmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' });
const longFmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'long' });
const isoDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' });
const wdayFmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long' });

// Relative Zeitwörter stammen aus dem Publikationstag des Artikels. Geht die Mail an
// einem späteren Berlin-Tag raus, werden sie zum Wochentag aufgelöst, damit keine
// veraltete Aktualität ("Nasdaq-Start für heute erwartet" am Folgetag) versendet wird.
function deStale(s, ts, sendDay) {
  if (!s || isoDayFmt.format(new Date(ts)) === sendDay) return s;
  // Letter-aware boundaries (JS \b is ASCII-only and breaks on umlauts like
  // "Morgenüberblick"). Case-sensitive: lowercase adverbs anywhere, capitalized only
  // at the start - nouns like "KI am Morgen" must survive untouched.
  const L = 'A-Za-zÀ-ÖØ-öø-ÿ';
  const mid = (w) => new RegExp('(^|[^' + L + '])' + w + '(?![' + L + '])', 'g');
  const start = (w) => new RegExp('^' + w + '(?![' + L + '])');
  const day = (d) => wdayFmt.format(new Date(d));
  return String(s)
    .replace(mid('heute'), (m, p) => p + day(ts))
    .replace(mid('gestern'), (m, p) => p + day(ts - 864e5))
    .replace(mid('morgen'), (m, p) => p + day(ts + 864e5))
    .replace(start('Heute'), () => day(ts))
    .replace(start('Gestern'), () => day(ts - 864e5))
    .replace(start('Morgen'), () => day(ts + 864e5));
}

// ISO-8601 week + week-year (the year the Thursday of that week falls in).
function isoWeekParts(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const w1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((t - w1) / 864e5 / 7 - ((3 - ((w1.getUTCDay() + 6) % 7)) / 7));
  return { week, year: t.getUTCFullYear() };
}
function isoWeek(dateStr) { return isoWeekParts(dateStr).week; }
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit' });

function utm(cfg, url, campaign, slot) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'utm_source=' + encodeURIComponent(cfg.utmSource) + '&utm_medium=email&utm_campaign=' + encodeURIComponent(campaign) + '&utm_content=' + encodeURIComponent(slot);
}

// sendDate: 'YYYY-MM-DD' (Europe/Berlin). Window: the 7 Berlin days ending at send-day midnight.
async function fetchWeek(cfg, sendDate, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const r = await doFetch(cfg.feed, { headers: { 'user-agent': 'weekly-newsletter/1.0' } });
  if (!r.ok) throw new Error('feed ' + r.status);
  const all = parseFeed(await r.text());
  const to = berlinMidnightUtc(sendDate);
  const from = to - 7 * 864e5;
  let week = all.filter((i) => i.ts >= from && i.ts < to);
  if (cfg.ownOnly) week = week.filter((i) => i.url.startsWith(cfg.site));
  if (cfg.allowPath) week = week.filter((i) => cfg.allowPath.test(new URL(i.url).pathname));
  week.sort((a, b) => b.ts - a.ts);
  // Editorial pools: preferred (daily analyses / own articles) first, the rest only fills.
  const isPref = (i) => {
    const path = new URL(i.url).pathname;
    if (cfg.preferPath && cfg.preferPath.test(path)) return true;
    if (cfg.preferSlug && cfg.preferSlug.test(path)) return true;
    if (cfg.preferBeforeHour != null && parseInt(hourFmt.format(new Date(i.ts)), 10) < cfg.preferBeforeHour) return true;
    return false;
  };
  const pref = week.filter(isPref);
  const rest0 = week.filter((i) => !isPref(i));
  const ordered = pref.concat(rest0);
  // Primary: newest preferred item per Berlin day first, then preferred by recency, then rest.
  const seenDay = new Set(); const primary = []; const rest = [];
  for (const i of ordered) {
    const day = isoDayFmt.format(new Date(i.ts));
    if (!seenDay.has(day) && primary.length < cfg.maxItems && pref.includes(i)) { seenDay.add(day); primary.push(i); } else rest.push(i);
  }
  for (const i of rest) { if (primary.length >= cfg.maxItems) break; primary.push(i); }
  const picked = new Set(primary);
  const more = week.filter((i) => !picked.has(i)).slice(0, cfg.maxMore);
  const iso = isoWeekParts(sendDate);
  const campaign = 'kw' + iso.week + '-' + iso.year;
  // Article images: only the site's own hero (same origin as the feed links) ever enters a mail.
  const ownImg = (i) => (i.img && i.img.startsWith(cfg.site + '/') ? i.img : null);
  const mapItem = (i, n) => ({ title: deStale(i.title, i.ts, sendDate), url: utm(cfg, i.url, campaign, 'artikel-' + n), orig: i.url, teaser: deStale(i.teaser, i.ts, sendDate), cat: i.cat, img: ownImg(i), dayLabel: dayFmt.format(new Date(i.ts)) });
  const items = primary.map((i, n) => mapItem(i, n + 1));
  const moreM = more.map((i, n) => ({ title: i.title, url: utm(cfg, i.url, campaign, 'mehr-' + (n + 1)) }));
  const fromD = new Date(from), toD = new Date(to - 864e5);
  const sameMonth = longFmt.format(fromD).split(' ')[1] === longFmt.format(toD).split(' ')[1];
  const range = sameMonth ? longFmt.format(fromD).split(' ')[0] + '–' + longFmt.format(toD) : longFmt.format(fromD) + '–' + longFmt.format(toD);
  const weekLabel = 'KW ' + iso.week + ' · ' + range;
  const extra = cfg.extra ? { ...cfg.extra, url: utm(cfg, cfg.extra.url, campaign, 'extra') } : null;
  const mapMore = (i, n) => ({ title: i.title, url: utm(cfg, i.url, campaign, 'mehr-' + n) });
  return { items, more: moreM, weekLabel, campaign, total: week.length, extra, _all: week, _map: mapItem, _mapMore: mapMore };
}

function subjectFor(cfg, items, total, moreCount = 0) {
  const first = items[0] ? items[0].title : '';
  const short = first.length > 52 ? first.slice(0, 52).replace(/\s+\S*$/, '') + '…' : first;
  let s = cfg.subjectPrefix + ': ' + short;
  const curated = items.length + moreCount - 1;
  if (curated > 0) s += ' +' + curated + ' weitere';
  return s;
}

module.exports = { parseFeed, fetchWeek, subjectFor, isoWeek, isoWeekParts, berlinMidnightUtc, utm };
