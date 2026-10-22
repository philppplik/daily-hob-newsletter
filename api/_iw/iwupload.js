'use strict';
// PDF-Upload aus dem IW-Workflow in den privaten Blob. Auth: HMAC ueber "upload:iwreport:<datum>".
const crypto = require('crypto');
const L = require('../_lw');
const IW = require('./iwlib');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).end();
  // Upload-only credential: IW_UPLOAD_SECRET signs only this endpoint (fallback: LW_SECRET).
  // Ein kompromittiertes Repo-Secret kann damit keine Abonnenten-Tokens faelschen.
  const key = process.env.IW_UPLOAD_SECRET || process.env.LW_SECRET || '';
  const want = Buffer.from(require('crypto').createHmac('sha256', key).update('upload:iwreport:' + date).digest('base64url'));
  const got = Buffer.from(String(req.headers['x-lw-auth'] || ''));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).end();
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 4000000) return res.status(413).end(); chunks.push(c); }
  const body = Buffer.concat(chunks);
  if (body.slice(0, 4).toString() !== '%PDF') return res.status(400).end();
  const r = await fetch('https://blob.vercel-storage.com/' + IW.iwReportPath(date), { method: 'PUT', body,
    headers: { authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN, 'x-api-version': '7', 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-content-type': 'application/pdf' } });
  if (!r.ok) return res.status(502).json({ ok: false, status: r.status });
  res.status(200).json({ ok: true });
};
