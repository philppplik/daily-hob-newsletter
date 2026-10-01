const { SITE, readToken, resend } = require('./_lib');

module.exports = async (req, res) => {
  const email = readToken(req.query && req.query.token);
  if (!email) return res.redirect(302, SITE + '/newsletter/?status=ungueltig');
  const segment = process.env.SEGMENT_ID;
  let r = await resend('/contacts', { email, unsubscribed: false, segments: [{ id: segment }] });
  if (!r.ok) {
    // contact already exists: only add to the segment, leave global status untouched
    r = await resend(`/contacts/${encodeURIComponent(email)}/segments/${segment}`, null, 'POST');
  }
  return res.redirect(302, SITE + '/newsletter/?status=' + (r.ok ? 'bestaetigt' : 'fehler'));
};
