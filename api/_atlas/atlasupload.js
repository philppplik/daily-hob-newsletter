// ZIP-Upload des Atlas-Datenpakets aus dem KIFB-Workflow in den privaten Blob. Auth: HMAC ueber "upload:atlas:<version>".
const crypto = require('crypto');
const { sign, atlasPath } = require('../_lw');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const v = String(req.query.v || '');
  if (!/^\d+\.\d+$/.test(v)) return res.status(400).end();
  const got = Buffer.from(String(req.headers['x-lw-auth'] || '')), want = Buffer.from(sign('upload:atlas:' + v));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).end();
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 20000000) return res.status(413).end(); chunks.push(c); }
  const body = Buffer.concat(chunks);
  if (body.slice(0, 4).toString('latin1') !== 'PK\x03\x04') return res.status(400).end();
  const r = await fetch('https://blob.vercel-storage.com/' + atlasPath(v), { method: 'PUT', body,
    headers: { authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN, 'x-api-version': '7', 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-content-type': 'application/zip' } });
  if (!r.ok) return res.status(502).json({ ok: false, status: r.status });
  res.status(200).json({ ok: true });
};
