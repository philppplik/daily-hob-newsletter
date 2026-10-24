'use strict';
// Eligibility + send loop for the weekly newsletter. Individual per-recipient sends
// (not broadcasts) so each mail carries its own one-click List-Unsubscribe token and
// each site's Wochenrückblick consent is enforced from our own opt-in records.
const L = require('../api/_lw');

async function resend(path, body, method) {
  const r = await fetch('https://api.resend.com' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null; try { json = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, json };
}

// Weekly eligibility from our OWN consent records only (no Resend segment involved):
// confirmed, still subscribed, with the SEPARATE weekly opt-in (nlOptIn) and without a
// newsletter-specific unsubscribe. A Resend segment membership or a record for another
// purpose (Tagesbericht, PDF, Atlas) never implies weekly consent.
async function eligible(cfg, deps) {
  const store = deps.store;
  const all = await store.list();
  const out = []; const seen = new Set();
  let recordCount = 0;
  for (const { rec } of all) {
    if (!rec || !rec.email) continue;
    recordCount++;
    if (!rec.confirmedAt || rec.unsubscribedAt) continue;
    if (rec.nlOptIn !== true) continue;
    if (rec.nlUnsub && rec.nlUnsub[cfg.key]) continue;
    const email = L.norm(rec.email);
    if (!email || seen.has(email)) continue;
    // syncApplied: this exact consent (confirmedAt) was already applied to the provider.
    // Once applied, provider preferences win forever - a later re-sync must NEVER
    // re-opt-in (a provider-page unsubscribe is not mirrored back to the blob).
    const syncApplied = !!(rec.nlSync && rec.nlSync.state === 'applied' && rec.nlSync.consentAt === rec.confirmedAt);
    seen.add(email); out.push({ email, id: L.idOf(email), syncApplied });
  }
  return { recipients: out, recordCount };
}

// Render + send to each recipient. Returns per-recipient outcomes; never throws mid-loop.
function requireSender(cfg) { if (!cfg.from) { const e = new Error('sender-unresolved: no verified sender configured for ' + cfg.key); e.code = 'sender-unresolved'; throw e; } }

async function sendAll(cfg, model, recipients, deps) {
  requireSender(cfg);
  const { render } = require('./template');
  const results = { sent: 0, failed: [] };
  for (const rcp of recipients) {
    const token = L.token('nl-' + cfg.key, rcp.id, 0);
    const unsubUrl = L.apiUrl('/lw/api/nlunsub?site=' + cfg.key + '&t=' + encodeURIComponent(token));
    const { html, text } = render({ cfg, subject: model.subject, preheader: model.preheader, weekLabel: model.weekLabel, items: model.items, more: model.more, unsubUrl });
    try {
      await L.sendMail({
        to: rcp.email, from: cfg.from, replyTo: cfg.replyTo, subject: model.subject, html, text,
        headers: { 'list-unsubscribe': '<' + unsubUrl + '>', 'list-unsubscribe-post': 'List-Unsubscribe=One-Click' }
      });
      results.sent++;
    } catch (e) {
      results.failed.push({ id: rcp.id, error: String(e && e.message || e) });
    }
    if (recipients.length > 1) await new Promise((r) => setTimeout(r, 150));
  }
  return results;
}

module.exports = { requireSender, eligible, sendAll, resend };
