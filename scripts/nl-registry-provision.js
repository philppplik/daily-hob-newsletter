'use strict';
// OFFLINE one-time provisioning of the dispatch registry. Run manually, once, while
// dispatch is disabled (NL_DISPATCH_ENABLED unset):
//   node scripts/nl-registry-provision.js          -> inspect only (never writes)
//   node scripts/nl-registry-provision.js --init   -> create ONLY if no registry exists
// The script NEVER overwrites an existing registry: with NL_REGISTRY_URL set it reads
// first and only inspects. After a successful --init it prints the canonical URL -
// set it as NL_REGISTRY_URL (plus NL_REGISTRY_KEY if you used a non-default key).
// There is no online init endpoint and no auto-create anywhere; a missing registry is
// fatal for dispatch by design.
const { provisionRegistry, blob } = require('../newsletter/dispatch');

(async () => {
  const init = process.argv.includes('--init');
  const url = process.env.NL_REGISTRY_URL || '';
  if (!init) {
    if (!url) { console.log('NL_REGISTRY_URL not set: nothing to inspect. Run with --init for the one-time setup.'); return; }
    const got = await blob.getWithEtag(url);
    if (!got) { console.log('registry NOT FOUND at NL_REGISTRY_URL (dispatch stays fatal-disabled).'); process.exitCode = 1; return; }
    console.log('registry OK:', JSON.stringify({ issues: Object.keys(got.value.issues || {}).length, initializedAt: got.value.initializedAt }));
    return;
  }
  if (url) {
    // A URL is already configured: verify, never write. A stale-404 overwrite after an
    // active claim/send would destroy ownership state - this path must not exist.
    const got = await blob.getWithEtag(url);
    if (got) { console.log('registry already exists at NL_REGISTRY_URL - inspect only, NOT overwriting.'); return; }
    console.error('NL_REGISTRY_URL is set but unreadable. Resolve manually; refusing to create over an ambiguous state.');
    process.exitCode = 1; return;
  }
  // Optional reviewed seed: node scripts/nl-registry-provision.js --init --seed <file.json>
  // File shape: { "issues": { "<site>-<YYYY>-W<ww>": { state, ... } }, "meta": { "minIssueWeek": "YYYY-Www" } }.
  // Strictly validated in provisionRegistry; a seed is written ONLY at creation time.
  const seedIdx = process.argv.indexOf('--seed');
  if (seedIdx === -1) { console.error('--init requires --seed <file.json>: the reviewed recovery seed ({ issues, meta.minIssueWeek }) is mandatory; meta-free creation is reserved for the internal storage probe.'); process.exitCode = 1; return; }
  let deps = {};
  if (seedIdx !== -1) {
    const file = process.argv[seedIdx + 1];
    if (!file) { console.error('--seed needs a JSON file path.'); process.exitCode = 1; return; }
    const fs = require('fs');
    let parsed; try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('seed file unreadable/invalid JSON:', e && e.message || e); process.exitCode = 1; return; }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.issues !== 'object' || typeof parsed.meta !== 'object') { console.error('seed file must be { issues: {...}, meta: { minIssueWeek } }'); process.exitCode = 1; return; }
    deps = { seedIssues: parsed.issues, seedMeta: parsed.meta };
    console.log('seed file loaded:', Object.keys(parsed.issues).length, 'issue entries, minIssueWeek', parsed.meta.minIssueWeek);
  }
  const out = await provisionRegistry(deps);
  if (!out.created) { console.log('registry already existed - inspect only, nothing written.'); return; }
  console.log('registry created and verified.');
  console.log('Set these env vars (Preview AND Production only when approved):');
  console.log('  NL_REGISTRY_URL=' + out.url);
  console.log('  NL_REGISTRY_KEY=' + (process.env.NL_REGISTRY_KEY || 'nl-registry/registry.json'));
})().catch((e) => { console.error('provision failed:', e && e.message || e); process.exitCode = 1; });
