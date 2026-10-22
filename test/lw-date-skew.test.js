'use strict';
// Regression: Tagesbericht-Dateiname = Europe/Berlin. Um 00-02 Uhr MESZ (22-24 UTC) darf
// latestReport nicht die Gestern-Ausgabe liefern, wenn die Berlin-Heute-Ausgabe existiert.
process.env.LW_SECRET = 'x'.repeat(40); process.env.LW_STORE = 'memory'; process.env.LW_MAIL = 'dry'; process.env.API_URL = 'https://api.test';
const test = require('node:test'); const assert = require('node:assert');
const L = require('../api/_lw');
const IW = require('../api/_iw/iwlib');

test('latestReport/latestIwReport: Berlin-Mitternacht schlaegt UTC-Datum', async (t) => {
  // 15.06.2026 22:30 UTC = 16.06.2026 00:30 MESZ (Berlin)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-15T22:30:00Z') });
  global.__reports = { '2026-06-16': Buffer.from('%PDF-kfb-heute') };
  global.__iwreports = { '2026-06-16': Buffer.from('%PDF-iw-heute') };
  const kfb = await L.latestReport();
  assert.equal(kfb.date, '2026-06-16', 'KIFB muss die Berlin-Heute-Ausgabe liefern, nicht UTC-Gestern');
  assert.equal(kfb.buf.toString(), '%PDF-kfb-heute');
  const iw = await IW.latestIwReport();
  assert.equal(iw.date, '2026-06-16', 'IW muss die Berlin-Heute-Ausgabe liefern, nicht UTC-Gestern');
  assert.equal(iw.buf.toString(), '%PDF-iw-heute');
});

test('latestReport: Tagwechsel-Fallback auf Gestern bleibt, wenn Heute fehlt', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-16T05:00:00Z') }); // 07:00 MESZ
  global.__reports = { '2026-06-15': Buffer.from('%PDF-kfb-gestern') };
  global.__iwreports = { '2026-06-15': Buffer.from('%PDF-iw-gestern') };
  const kfb = await L.latestReport();
  assert.equal(kfb.date, '2026-06-15');
  const iw = await IW.latestIwReport();
  assert.equal(iw.date, '2026-06-15');
});
