'use strict';
// URL contract: every mailed link must resolve correctly under ALL API_URL shapes -
// bare host, legacy trailing /lw (production since 20.10.), trailing slash, unset
// (Preview/tests). Never /lw/lw/..., never a missing /lw.
process.env.LW_STORE = 'memory';
process.env.LW_SECRET = process.env.LW_SECRET || 'test-secret-test-secret-test-secret';
const test = require('node:test');
const assert = require('node:assert');

const SHAPES = ['', 'https://dhn.vercel.app', 'https://dhn.vercel.app/', 'https://dhn.vercel.app/lw', 'https://dhn.vercel.app/lw/'];
const want = (shape, path) => {
  const b = shape.replace(/\/+$/, '');
  return b + (b.endsWith('/lw') ? path.slice(3) : path);
};

test('apiUrl normalization across all API_URL shapes', () => {
  const L = require('../api/_lw');
  for (const shape of SHAPES) {
    process.env.API_URL = shape;
    for (const p of ['/lw/api/confirm', '/lw/api/nlunsub', '/lw/api/tkdl', '/lw/api/iwpdf', '/lw/api/atlasdl']) {
      const u = L.apiUrl(p + '?x=1');
      assert.equal(u, want(shape, p + '?x=1'), 'API_URL=' + JSON.stringify(shape) + ' path=' + p);
      assert.ok(!u.includes('/lw/lw/'), 'no double /lw under ' + JSON.stringify(shape));
    }
  }
  delete process.env.API_URL;
});

const bust = () => { for (const k of Object.keys(require.cache)) if (k.includes('/api/') || k.includes('/newsletter/')) delete require.cache[k]; };
const call = async (h, body) => {
  const r = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await h({ method: 'POST', url: '/x', headers: { 'x-forwarded-for': '203.0.113.9' }, body }, r); // readBody accepts req.body objects
  return r;
};

test('all DOI mail links + newsletter unsub link honor the contract under bare host AND legacy /lw', async () => {
  for (const shape of ['https://dhn.vercel.app', 'https://dhn.vercel.app/lw', 'https://dhn.vercel.app/lw/']) {
    process.env.API_URL = shape; process.env.LW_MAIL = 'dry';
    bust();
    const L = require('../api/_lw');
    const sent = [];
    L.sendMail = async (m) => { sent.push(m); return { id: 'dry' }; };
    const senders = ['../api/_lwh/subscribe', '../api/_lwh/tksub', '../api/_iw/iwsub', '../api/_atlas/atlassub'].map(require);
    let i = 0;
    for (const h of senders) { i++; await call(h, { email: 'url' + i + Date.now() + '@test.de', consent: true, nl: true, website: '' }); }
    assert.equal(sent.length, 4, 'four DOI mails under ' + shape + ' (fa uses the same apiUrl builder, checked below)');
    for (const m of sent) {
      const link = (m.text.match(/https?:\/\/\S+/) || [])[0] || '';
      assert.ok(link.includes('/lw/api/confirm'), 'DOI link uses public confirm route: ' + link);
      assert.ok(!link.includes('/lw/lw/'), 'no double /lw: ' + link);
      assert.equal(link.replace(/^(https?:\/\/[^/]+).*$/, '$1'), 'https://dhn.vercel.app', 'host intact: ' + link);
      assert.equal(link.replace(/^https?:\/\/[^/]+/, '').split('?')[0], '/lw/api/confirm', 'exactly one /lw, correct path: ' + link);
    }
    // fa DOI builder shares L.apiUrl (inline slot): assert its constructed URL directly
    const faLink = L.apiUrl('/lw/api/confirm?s=fa&t=x');
    assert.ok(!faLink.includes('/lw/lw/') && faLink.includes('/lw/api/confirm'), 'fa DOI link: ' + faLink);
    // newsletter one-click unsub link (core.sendAll)
    const core = require('../newsletter/core');
    const { SITES } = require('../newsletter/config');
    sent.length = 0;
    const out = await core.sendAll(SITES.kifb, { subject: 's', preheader: 'p', weekLabel: 'W', items: [{ title: 't', url: 'https://kifachblatt.de/a', teaser: '' }], more: [] }, [{ email: 'u1@test.de', id: L.idOf('u1@test.de') }], {});
    assert.equal(out.sent, 1, 'newsletter test mail sent: ' + JSON.stringify(out));
    const unsub = ((sent[0] && sent[0].html || '').match(/https?:\/\/[^"'\s]*nlunsub[^"'\s]*/) || [])[0] || '';
    assert.ok(unsub.includes('/lw/api/nlunsub') && !unsub.includes('/lw/lw/'), 'unsub link: ' + unsub);
    delete process.env.API_URL;
  }
  delete process.env.LW_MAIL;
});
