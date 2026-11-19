'use strict';
// Curated weekly selection (freigegebene Gestaltung: kuratierte lesbare Beitragsauswahl,
// als Symbolbild markierte Illustrationen wo nötig). Pure application of a reviewed
// nl-curated/<site>-<date>.json document onto a fetchWeek result. The document can
// only select, order and re-image articles that are actually in the week's feed —
// it can never inject a foreign URL into a mail.
// Shape: { items: [ { url, img?: string | 'none', imgLabel?: string } ] }
//   url      canonical feed URL of the article (as in feed.xml, without UTM)
//   img      omitted: keep the feed hero; 'none': render without image;
//            same-origin URL: symbolic illustration or alternative own image
//   imgLabel visible caption under the image, e.g. 'KI-Illustration · Symbolbild'
function applyCurated(week, curated, cfg) {
  const list = curated && Array.isArray(curated.items) ? curated.items : [];
  // Match against the FULL filtered week pool (ownOnly/allowPath/time window already
  // applied by fetchWeek), not only the 3 primary picks. Feed duplicates collapse to
  // the first (newest) occurrence; foreign/out-of-window URLs stay excluded.
  const hasAll = Array.isArray(week._all) && week._all.length > 0;
  const all = hasAll ? week._all : (week.items || []);
  const key = (i) => i.orig || (typeof i.url === 'string' ? i.url.split('?')[0] : '');
  const byOrig = new Map();
  for (const i of all) { const k = key(i); if (k && !byOrig.has(k)) byOrig.set(k, i); }
  const maxItems = cfg.maxItems || 3;
  const maxMore = cfg.maxMore || 6;
  const items = [];
  const skipped = [];
  const picked = new Set();
  for (const entry of list) {
    if (!entry || typeof entry.url !== 'string') { skipped.push('(invalid entry)'); continue; }
    const hit = byOrig.get(entry.url);
    if (!hit) { skipped.push(entry.url); continue; } // not in this week's feed: never send
    if (picked.has(entry.url)) { skipped.push(entry.url); continue; } // duplicate lead: count once
    if (items.length >= maxItems) { skipped.push(entry.url); continue; }
    const it = week._map ? week._map(hit, items.length + 1) : { ...hit };
    if (entry.img === 'none' || entry.img === null) it.img = null;
    else if (typeof entry.img === 'string') it.img = entry.img.startsWith(cfg.site + '/') ? entry.img : null;
    if (it.img && typeof entry.imgLabel === 'string' && entry.imgLabel) it.imgLabel = entry.imgLabel;
    items.push(it);
    picked.add(key(hit));
  }
  // Rest of the week from the FULL pool minus picked leads, unique by canonical URL,
  // capped at maxMore only after dedupe (the "more" list stays a complete remainder).
  // Without _all (legacy caller) the remainder falls back to the old items+more pool.
  const restSrc = hasAll ? all : (week.items || []).concat(week.more || []);
  const more = [];
  const seen = new Set(picked);
  for (const i of restSrc) {
    const k = key(i);
    if (!k || seen.has(k)) continue;
    if (more.length >= maxMore) break;
    seen.add(k);
    more.push(week._mapMore ? week._mapMore(i, more.length + 1) : { title: i.title, url: i.url });
  }
  return { ...week, items, more, curatedApplied: items.length, curatedSkipped: skipped };
}
module.exports = { applyCurated };
