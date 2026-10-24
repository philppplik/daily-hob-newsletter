'use strict';
// Routing guard: every public route emitted in mails/links must be covered by a
// vercel.json rewrite into an existing function slot (48h DOI-link compatibility).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

test('all public /lw/api/* routes used in code resolve via rewrites to existing function slots', () => {
  const rewrites = JSON.parse(fs.readFileSync(__dirname + '/../vercel.json', 'utf8')).rewrites;
  const resolve = (src) => {
    for (const r of rewrites) {
      const pat = '^' + r.source.replace(/:[^/]+/g, '([^/]+)') + '$';
      const m = src.match(new RegExp(pat));
      if (m) return r.destination.replace(/:([^/]+)/g, (_, g) => m[(r.source.match(/:/g) || []).length === 1 ? 1 : 0] || m[1]);
    }
    return null;
  };
  // every public route the code links to (DOI mails, unsub links, site JS, admin calls)
  const used = ['/lw/api/confirm', '/lw/api/subscribe', '/lw/api/pdf', '/lw/api/tkdl', '/lw/api/tksub', '/lw/api/unsub', '/lw/api/upload',
    '/lw/api/atlassub', '/lw/api/atlasdl', '/lw/api/atlasupload', '/lw/api/iwsub', '/lw/api/iwpdf', '/lw/api/iwupload', '/lw/api/iwunsub',
    '/lw/api/fasub', '/lw/api/nlweekly', '/lw/api/nlunsub'];
  for (const u of used) {
    const dest = resolve(u);
    assert.ok(dest, 'no rewrite for ' + u);
    // destination must map to an existing function slot: /api/<slot>/<action> or /api/<file>
    const parts = dest.split('/').filter(Boolean); // ['api', slot, action?]
    let slotPath;
    if (parts.length === 3) slotPath = __dirname + '/../api/' + parts[1] + '/[action].js';
    else slotPath = __dirname + '/../api/' + parts[1] + '.js';
    assert.ok(fs.existsSync(slotPath), u + ' -> ' + dest + ' but no function slot at ' + slotPath);
    if (parts.length === 3) {
      const slot = fs.readFileSync(slotPath, 'utf8');
      if (slot.includes('handlers = {')) assert.ok(slot.includes(parts[2] + ':'), dest + ' dispatcher lacks action "' + parts[2] + '"');
      // single-purpose slots (lw-fa) handle their one action inline - no map to check
    }
  }
  // legacy daily-hob endpoint stays untouched (its own function, own token format)
  assert.ok(fs.existsSync(__dirname + '/../api/confirm.js'), 'legacy /api/confirm preserved');
  // DOI mails must link the PUBLIC route, never the legacy direct function path
  for (const f of ['api/_lwh/subscribe.js', 'api/_lwh/tksub.js', 'api/_iw/iwsub.js', 'api/_atlas/atlassub.js', 'api/lw-fa/[action].js']) {
    const src = fs.readFileSync(__dirname + '/../' + f, 'utf8');
    assert.ok(!src.includes("L.API + '/api/confirm"), f + ' links legacy /api/confirm directly (wrong token format there)');
    assert.ok(!src.includes("L.API + '/lw/api/confirm"), f + ' must not concatenate L.API directly (breaks under legacy trailing-/lw API_URL)');
    assert.ok(src.includes("L.apiUrl('/lw/api/confirm"), f + ' must link via L.apiUrl (normalizes bare host and legacy /lw base)');
  }
});
