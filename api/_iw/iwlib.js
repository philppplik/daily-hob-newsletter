'use strict';
// Intelligenz-Welt-Leadwall: eigene Einwilligungs-Records (Prefix optin-iw/), eigener Blob-Pfad (reports-iw/).
// Gleiche Primitive wie KIFB (_lw), aber strikt getrennte Einwilligung: nur Tagesbericht-PDF, kein Newsletter, kein Shop.
const L = require('../_lw');
const SITE_IW = L.SITE_IW;
const IW_TEXT_VERSION = 'iw-2026-10-23-v2'; // Einwilligungstext IW PDF-Zugang Tagesausgabe (23.10.2026)
const IW_FROM = process.env.IW_MAIL_FROM || 'Intelligenz Welt <briefing@hob.philipp-paulik.de>'; // verifizierte Absenderdomain, kein unverifizierter IW-Absender
const iwStore = L.storeFor('optin-iw/');
// Report-PDFs: unratbarer deterministischer Pfad (Datum + HMAC), niemals oeffentlich verlinkt.
const iwReportPath = (date) => 'reports-iw/intelligenz-welt-tagesausgabe-' + date + '-' + L.sign('iwreport:' + date).slice(0, 24) + '.pdf';
async function fetchIwReport(date) {
  if (process.env.LW_STORE === 'memory') return (global.__iwreports || {})[date] || null;
  const id = String(process.env.BLOB_STORE_ID || String(process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[3] || '').replace(/^store_/, '').toLowerCase();
  const r = await fetch('https://' + id + '.private.blob.vercel-storage.com/' + iwReportPath(date) + '?cache=0', { headers: { authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN } });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
async function latestIwReport() {
  // Ausgabedatum ist Europe/Berlin (Dateiname), nicht UTC: um 00-02 Uhr MESZ weichen beide ab.
  const berlin = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const days = [berlin];
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    if (!days.includes(d)) days.push(d);
  }
  for (const d of days) { const b = await fetchIwReport(d); if (b) return { date: d, buf: b }; }
  return null;
}
module.exports = { SITE_IW, IW_TEXT_VERSION, IW_FROM, iwStore, iwReportPath, fetchIwReport, latestIwReport };
