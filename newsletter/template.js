'use strict';
// Shared weekly newsletter template: table layout, inline CSS, 600px, system fonts,
// light theme (#fff / #ccc / #a1a1a1), no tracking pixels, plain-text part from the same model.
const { POSTAL } = require('./config');
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function masthead(cfg) {
  if (cfg.logo) return '<img src="' + cfg.logo + '" width="40" height="40" alt="' + esc(cfg.name) + '" style="display:block;width:40px;height:40px;border-radius:9px;border:1px solid #cccccc">';
  return '<span style="font:800 22px/1 ' + FONT + ';color:#141414;letter-spacing:-.02em">' + esc(cfg.wordmark.pre) + '<span style="color:' + cfg.accent + '">' + esc(cfg.wordmark.post) + '</span></span>';
}

function itemBlock(cfg, it, first) {
  return '<tr><td style="background:#ffffff;border-left:1px solid #cccccc;border-right:1px solid #cccccc;' + (first ? '' : 'border-top:1px solid #cccccc;') + 'padding:20px 28px">'
    + (it.cat ? '<p style="margin:0 0 5px;font:600 11px/1.4 ' + FONT + ';letter-spacing:.12em;text-transform:uppercase;color:' + cfg.accent + '">' + esc(it.cat) + (it.dayLabel ? ' &middot; ' + esc(it.dayLabel) : '') + '</p>'
      : (it.dayLabel ? '<p style="margin:0 0 5px;font:600 11px/1.4 ' + FONT + ';letter-spacing:.12em;text-transform:uppercase;color:#a1a1a1">' + esc(it.dayLabel) + '</p>' : ''))
    + '<a href="' + it.url + '" style="font:700 17px/1.35 ' + FONT + ';color:#141414;text-decoration:none">' + esc(it.title) + '</a>'
    + (it.teaser ? '<p style="margin:7px 0 9px;font:400 14px/1.55 ' + FONT + ';color:#3d3d3d">' + esc(it.teaser) + '</p>' : '<p style="margin:7px 0 9px"></p>')
    + '<a href="' + it.url + '" style="font:700 13.5px/1.4 ' + FONT + ';color:' + cfg.accent + ';text-decoration:none">' + esc(cfg.cta) + ' &rarr;</a>'
    + '</td></tr>';
}

function render({ cfg, subject, preheader, weekLabel, items, more, unsubUrl }) {
  const first = items[0] || { title: subject };
  const S = cfg.site;
  const head = '<tr><td style="background:#ffffff;border:1px solid #cccccc;border-bottom:0;border-radius:14px 14px 0 0;padding:24px 28px 20px">'
    + masthead(cfg)
    + '<p style="margin:16px 0 0;font:600 11px/1.4 ' + FONT + ';letter-spacing:.14em;text-transform:uppercase;color:#a1a1a1">' + esc(cfg.product) + ' &middot; ' + esc(weekLabel) + '</p>'
    + '<h1 style="margin:10px 0 0;font:800 23px/1.28 ' + FONT + ';color:#141414;letter-spacing:-.02em">' + esc(first.title) + '</h1>'
    + '<p style="margin:10px 0 0;font:400 15px/1.6 ' + FONT + ';color:#3d3d3d">' + esc(cfg.intro) + '</p>'
    + '</td></tr>';
  const blocks = items.map((it, i) => itemBlock(cfg, it, i === 0)).join('');
  let moreBlock = '';
  if (more && more.length) {
    moreBlock = '<tr><td style="background:#ffffff;border-left:1px solid #cccccc;border-right:1px solid #cccccc;border-top:1px solid #cccccc;padding:18px 28px">'
      + '<p style="margin:0 0 8px;font:600 11px/1.4 ' + FONT + ';letter-spacing:.12em;text-transform:uppercase;color:#a1a1a1">' + esc(cfg.moreLabel) + '</p>'
      + more.map((m) => '<p style="margin:0 0 7px;font:500 14px/1.5 ' + FONT + '"><a href="' + m.url + '" style="color:#141414;text-decoration:none">' + esc(m.title) + '</a> <a href="' + m.url + '" style="color:' + cfg.accent + ';text-decoration:none;font-weight:700">&rarr;</a></p>').join('')
      + '</td></tr>';
  }
  const ex = cfg.extra;
  const extraBlock = ex ? '<tr><td style="background:#fafafa;border-left:1px solid #cccccc;border-right:1px solid #cccccc;border-top:1px solid #cccccc;padding:18px 28px">'
    + '<p style="margin:0 0 5px;font:600 11px/1.4 ' + FONT + ';letter-spacing:.12em;text-transform:uppercase;color:' + cfg.accent + '">' + esc(ex.label) + '</p>'
    + '<p style="margin:0 0 8px;font:400 14px/1.55 ' + FONT + ';color:#3d3d3d">' + esc(ex.text) + '</p>'
    + '<a href="' + ex.url + '" style="font:700 13.5px/1.4 ' + FONT + ';color:' + cfg.accent + ';text-decoration:none">' + esc(ex.cta) + ' &rarr;</a>'
    + '</td></tr>' : '';
  const footer = '<tr><td style="background:#fafafa;border:1px solid #cccccc;border-top:0;border-radius:0 0 14px 14px;padding:18px 28px">'
    + '<p style="margin:0 0 8px;font:400 12px/1.6 ' + FONT + ';color:#6b6b6b">Du erhältst diese E-Mail, weil du dich bei ' + esc(cfg.name) + ' für den Wochenrückblick angemeldet und bestätigt hast. Keine Tracking-Pixel in unseren Mails.</p>'
    + '<p style="margin:0 0 8px;font:400 12px/1.6 ' + FONT + '"><a href="' + unsubUrl + '" style="color:#5f5f5f;text-decoration:underline">Abmelden</a> &middot; <a href="' + S + '/impressum" style="color:#5f5f5f;text-decoration:underline">Impressum</a> &middot; <a href="' + S + '/datenschutz" style="color:#5f5f5f;text-decoration:underline">Datenschutz</a></p>'
    + (cfg.footerNote ? '<p style="margin:0 0 8px;font:400 12px/1.6 ' + FONT + ';color:#6b6b6b">' + esc(cfg.footerNote) + '</p>' : '')
    + '<p style="margin:0;font:400 12px/1.6 ' + FONT + ';color:#6b6b6b">' + esc(cfg.name) + ' ist ein Angebot von ' + esc(POSTAL) + '</p>'
    + '</td></tr>';
  const html = '<!doctype html><html lang="de" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>' + esc(subject) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f5f5f6;-webkit-text-size-adjust:100%">'
    + '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">' + esc(preheader) + '&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f6"><tr><td align="center" style="padding:28px 12px">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">'
    + head + blocks + moreBlock + extraBlock + footer
    + '</table>'
    + '<p style="margin:14px 0 0;font:400 11px/1.5 ' + FONT + ';color:#6b6b6b;text-align:center">&copy; ' + new Date().getFullYear() + ' ' + esc(cfg.name) + '</p>'
    + '</td></tr></table></body></html>';
  const text = [subject, '', cfg.intro, '', '--- ' + cfg.sectionLabel + ' (' + weekLabel + ') ---', '']
    .concat(items.map((it, i) => (i + 1) + '. ' + it.title + '\n' + (it.teaser ? it.teaser + '\n' : '') + it.url))
    .concat(more && more.length ? ['', '--- ' + cfg.moreLabel + ' ---'].concat(more.map((m) => '- ' + m.title + '\n  ' + m.url)) : [])
    .concat(ex ? ['', ex.label + ': ' + ex.text + '\n' + ex.url] : [])
    .concat(['', '---', 'Du erhältst diese E-Mail, weil du dich bei ' + cfg.name + ' für den Wochenrückblick angemeldet und bestätigt hast.',
      'Abmelden: ' + unsubUrl,
      'Impressum: ' + S + '/impressum · Datenschutz: ' + S + '/datenschutz',
      cfg.footerNote || '',
      cfg.name + ' ist ein Angebot von ' + POSTAL].filter(Boolean));
  return { html, text: text.join('\n') };
}
module.exports = { render, esc };
