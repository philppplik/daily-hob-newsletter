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
  const byOrig = new Map((week.items || []).map((it) => [it.orig, it]));
  const pool = (week.items || []).slice();
  const poolMore = (week.more || []).slice();
  const items = [];
  const skipped = [];
  for (const entry of list) {
    if (!entry || typeof entry.url !== 'string') { skipped.push('(invalid entry)'); continue; }
    const hit = byOrig.get(entry.url);
    if (!hit) { skipped.push(entry.url); continue; } // not in this week's feed: never send
    const it = { ...hit };
    if (entry.img === 'none' || entry.img === null) it.img = null;
    else if (typeof entry.img === 'string') it.img = entry.img.startsWith(cfg.site + '/') ? entry.img : null;
    if (it.img && typeof entry.imgLabel === 'string' && entry.imgLabel) it.imgLabel = entry.imgLabel;
    items.push(it);
    pool.splice(pool.indexOf(hit), 1);
  }
  // Uncurated remainder keeps the week complete as plain links under "more".
  const more = pool.concat(poolMore);
  return { ...week, items, more, curatedApplied: items.length, curatedSkipped: skipped };
}
module.exports = { applyCurated };
