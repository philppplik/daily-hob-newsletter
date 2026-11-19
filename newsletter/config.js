'use strict';
// Weekly Sunday newsletter: per-site brand, sender, segment and content config.
// Sender is FAIL CLOSED: kifb uses its verified domain by default; IW/FA send ONLY when
// IW_MAIL_FROM / FA_MAIL_FROM is explicitly configured after the user's sender-domain
// decision and Resend verification. No fallback onto other verified identities.
const SITES = {
  kifb: {
    key: 'kifb',
    name: 'KI Fachblatt',
    product: 'KIFB-Wochenrückblick',
    site: 'https://kifachblatt.de',
    feed: 'https://kifachblatt.de/feed.xml',
    accent: '#7040cd',
    logo: 'https://kifachblatt.de/assets/logo-192.png',
    wordmark: null,
    from: process.env.MAIL_FROM || 'KI Fachblatt <magazin@kifachblatt.de>',
    segmentId: process.env.NL_SEGMENT_ID_KIFB || null, // existing segment id - PENDING user approval, unset by default
    topicId: process.env.NL_TOPIC_ID_KIFB || null, // private topic - PENDING user approval; required for any broadcast
    replyTo: process.env.MAIL_REPLY_TO || 'redaktion@kifachblatt.de',
    storePrefix: 'optin/',
    cta: 'Analyse lesen',
    sectionLabel: 'Analysen der Woche',
    moreLabel: 'Weitere Artikel dieser Woche',
    intro: 'Die KI-Woche in kompakter Form: die wichtigsten Analysen aus dem KI Fachblatt, mit Quellen und Einordnung - direkt zum Weiterlesen.',
    extra: {
      label: 'Aus dem Modell-Atlas',
      text: 'Offene Gewichte, starke Karten: Der Modell-Atlas sammelt die wichtigsten Modelle mit Benchmarks, Kosten und Datenblatt.',
      cta: 'Atlas öffnen',
      url: 'https://kifachblatt.de/modell-atlas'
    },
    footerNote: null,
    maxItems: 3,
    maxMore: 6,
    ownOnly: true,
    // Editorial digest: daily analyses first (slug -analyse or morning publication < 10:00 Berlin),
    // knowledge-base updates only fill remaining slots after that.
    preferSlug: /-analyse\/?$/,
    preferBeforeHour: 10,
    utmSource: 'kifb-newsletter',
    subjectPrefix: 'KIFB-Wochenrückblick',
    unsubPage: '/abmelden?ok=1'
  },
  iw: {
    key: 'iw',
    name: 'Intelligenz Welt',
    product: 'IW-Wochenrückblick',
    site: 'https://intelligenz-welt.de',
    feed: 'https://intelligenz-welt.de/feed.xml',
    accent: '#1d6bc0',
    logo: 'https://intelligenz-welt.de/apple-touch-icon.png',
    wordmark: null,
    from: process.env.IW_MAIL_FROM || null, // fail closed until sender domain decided + verified
    segmentId: process.env.NL_SEGMENT_ID_IW || null, // PENDING user approval
    topicId: process.env.NL_TOPIC_ID_IW || null, // PENDING user approval
    replyTo: null,
    storePrefix: 'optin-iw/',
    cta: 'Artikel lesen',
    sectionLabel: 'Die KI-Woche',
    moreLabel: 'Weitere Artikel dieser Woche',
    intro: 'Was diese Woche in der KI-Welt los war: die wichtigsten Meldungen von Intelligenz Welt, kurz eingeordnet und verlinkt.',
    extra: {
      label: 'Porträts und Steckbriefe',
      text: 'Unternehmen und Modelle im Profil: Hintergründe, Zahlen und Einordnungen zum Nachschlagen.',
      cta: 'Porträts ansehen',
      url: 'https://intelligenz-welt.de/ki-modelle/'
    },
    footerNote: null,
    maxItems: 3,
    maxMore: 8,
    ownOnly: true,
    // Editorial digest: own articles only; /news/ briefs fill after /artikel/.
    allowPath: /^\/(artikel|news)\//,
    preferPath: /^\/artikel\//,
    utmSource: 'iw-newsletter',
    subjectPrefix: 'IW-Wochenrückblick',
    unsubPage: '/abmelden/?ok=1'
  },
  fa: {
    key: 'fa',
    name: 'finanz adjust', // Hausmarke zweiteilig wie auf der Site
    product: 'FA-Wochenrückblick',
    site: 'https://finanz-adjust.de',
    feed: 'https://finanz-adjust.de/feed.xml',
    accent: '#1c66cb',
    logo: null,
    wordmark: { pre: 'finanz ', post: 'adjust' }, // Hausmarke zweiteilig wie auf der Site
    from: process.env.FA_MAIL_FROM || null, // fail closed until sender domain decided + verified
    segmentId: process.env.NL_SEGMENT_ID_FA || null, // PENDING user approval
    topicId: process.env.NL_TOPIC_ID_FA || null, // PENDING user approval
    replyTo: null,
    storePrefix: 'optin-fa/',
    cta: 'Weiterlesen',
    sectionLabel: 'Finanzwissen der Woche',
    moreLabel: 'Weitere Artikel dieser Woche',
    intro: 'Neues Finanzwissen zum Nachlesen: die Erklär-Artikel der Woche von finanz adjust, sachlich aufbereitet und ohne Anlageberatung. Die Marktzahlen der Woche liefern die täglichen PDF-Berichte (Link unten).',
    extra: {
      label: 'Tagesberichte der Woche',
      text: 'Jeden Morgen als PDF: Indizes, Gewinner und Verlierer, Devisen und die wichtigsten Schlagzeilen.',
      cta: 'Zur Berichts-Übersicht',
      url: 'https://finanz-adjust.de/berichte/'
    },
    footerNote: 'Alle Inhalte dienen ausschließlich der Information und sind keine Anlageberatung.',
    maxItems: 3,
    maxMore: 8,
    ownOnly: true,
    // Editorial digest: only FA's own /artikel/ explainer articles; aggregated news pages
    // (/nachricht/, /investing/, syndicated .html items, ...) never enter the digest.
    allowPath: /^\/artikel\//,
    utmSource: 'fa-newsletter',
    subjectPrefix: 'FA-Wochenrückblick',
    unsubPage: '/abmelden/?ok=1'
  }
};
const POSTAL = 'Philipp Paulik, Mozartstraße 1, 53819 Neunkirchen-Seelscheid, Deutschland';
module.exports = { SITES, POSTAL };
