// TEMPORAER: Resend-Domain anlegen/lesen/verifizieren. Auth: HMAC "admin:<action>". Nach Einrichtung entfernen.
const crypto = require('crypto');
const { sign } = require('./_lw');
module.exports = async (req, res) => {
  const a = String(req.query.a || '');
  const got = Buffer.from(String(req.headers['x-lw-auth'] || '')), want = Buffer.from(sign('admin:' + a));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).end();
  const h = { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' };
  let r;
  if (a === 'list') r = await fetch('https://api.resend.com/domains', { headers: h });
  else if (a === 'create') r = await fetch('https://api.resend.com/domains', { method: 'POST', headers: h, body: JSON.stringify({ name: 'kifachblatt.de', region: 'eu-west-1' }) });
  else if (a === 'get' || a === 'verify') {
    const id = String(req.query.id || '').replace(/[^a-zA-Z0-9-]/g, '');
    r = await fetch('https://api.resend.com/domains/' + id + (a === 'verify' ? '/verify' : ''), { method: a === 'verify' ? 'POST' : 'GET', headers: h });
  } else return res.status(400).end();
  res.status(200).setHeader('content-type', 'application/json').end(await r.text());
};
