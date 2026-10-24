'use strict';
// finanzadjust-Wochenrückblick: eigene Einwilligungs-Records (Prefix optin-fa/).
// FA hat kein PDF-Gate - das Produkt ist der sonntägliche Newsletter selbst.
const L = require('../_lw');
const SITE_FA = L.SITE_FA;
const FA_TEXT_VERSION = 'fa-2026-10-24-v1'; // Einwilligungstext FA-Wochenrückblick (24.10.2026)
const FA_FROM = process.env.FA_MAIL_FROM || null; // FAIL CLOSED: kein Versand, bis die Absenderdomain vom Nutzer entschieden und in Resend verifiziert ist; kein Fallback auf andere Identitaeten
const faStore = L.storeFor('optin-fa/');
module.exports = { SITE_FA, FA_TEXT_VERSION, FA_FROM, faStore };
