const { SITE, readToken, resend } = require('./_lib');

module.exports = async (req, res) => {
  const t = readToken(req.query && req.query.token, true);
  if (!t) return res.redirect(302, SITE + '/newsletter?status=ungueltig');
  const { email, src } = t;
  const segment = process.env.SEGMENT_ID;
  let r = await resend('/contacts', { email, unsubscribed: false, segments: [{ id: segment }] });
  if (!r.ok) {
    // contact already exists: only add to the segment, leave global status untouched
    r = await resend(`/contacts/${encodeURIComponent(email)}/segments/${segment}`, null, 'POST');
  }
  if (src === 'dossier') return res.redirect(302, SITE + (r.ok ? '/dossier-danke' : '/dossier?status=fehler'));
  return res.redirect(302, SITE + '/newsletter?status=' + (r.ok ? 'bestaetigt' : 'fehler'));
};
