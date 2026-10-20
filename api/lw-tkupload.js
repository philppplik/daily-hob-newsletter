'use strict';
// TEMPORAER: einmaliger Upload des Toolkit-ZIP (Key nur als SHA-256 im Code). Wird nach dem Upload entfernt.
const crypto = require('crypto');
const { toolkitPath } = require('./_lw');
const H = 'acccea7bd84d31960ec70da4ca14813eff21aa73a5873a73cbbf92b924adbbec';
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const v = String(req.query.v || '');
  if (!/^\d+\.\d+$/.test(v)) return res.status(400).end();
  const got = Buffer.from(crypto.createHash('sha256').update(String(req.headers['x-tk-key'] || '')).digest('hex')), want = Buffer.from(H);
  if (!crypto.timingSafeEqual(got, want)) return res.status(401).end();
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 4300000) return res.status(413).end(); chunks.push(c); }
  const body = Buffer.concat(chunks);
  if (body.slice(0, 2).toString() !== 'PK') return res.status(400).end();
  const r = await fetch('https://blob.vercel-storage.com/' + toolkitPath(v), { method: 'PUT', body,
    headers: { authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN, 'x-api-version': '7', 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-content-type': 'application/zip' } });
  if (!r.ok) return res.status(502).json({ ok: false, status: r.status });
  res.status(200).json({ ok: true, bytes: n });
};
