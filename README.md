# Daily Hob Newsletter API

Zwei Vercel-Funktionen (Region fra1) für die Double-Opt-In-Anmeldung auf https://hob.philipp-paulik.de.

- `POST /api/subscribe` nimmt `{ email, consent: true }` entgegen (Honeypot-Feld `website`, CORS nur Daily-Hob-Domain, einfaches Rate-Limit). Es wird nichts gespeichert. Die Funktion verschickt über Resend eine Bestätigungsmail mit signiertem Link (HMAC, 48 h gültig).
- `GET /api/confirm?token=...` prüft das Token, legt den Kontakt in Resend an (Segment "Daily Hob") und leitet auf `/newsletter/` weiter. Bereits vorhandene Kontakte werden nur dem Segment hinzugefügt, ihr globaler Status bleibt unberührt.

Umgebungsvariablen (nur in Vercel gesetzt): `RESEND_API_KEY`, `SEGMENT_ID`, `SECRET`.

## Wochen-Newsletter (KIFB, Intelligenz Welt, finanzadjust)

Gemeinsames Modul für die sonntäglichen Wochen-Newsletter der drei Sites, aufgebaut auf der bestehenden Leadwall-Infrastruktur (Blob-Opt-ins, Resend-Segmente, HMAC-Tokens). Keine neuen Secrets oder Env-Variablen nötig.

### Aufbau

- `newsletter/config.js` – Marken-, Absender-, Segment- und Content-Konfiguration pro Site (`kifb`, `iw`, `fa`) inkl. Postanschrift (Impressumspflicht) und RSS-Feed.
- `newsletter/template.js` – geteiltes HTML-Template (600 px, Tabellen-Layout, inline CSS, helles Theme, Logo oben/unten, Preheader, Footer mit Abmeldelink/Impressum/Datenschutz). Keine Tracking-Pixel. Plain-Text-Alternative inklusive.
- `newsletter/content.js` – liest den RSS-Feed der Site, wählt die Artikel des Berliner Wochenfensters `[Versandtag − 7 Tage, Versandtag)` aus (pro Tag der neueste Artikel zuerst, dann Auffüllung), hängt UTM-Parameter an (`utm_source=<site>-newsletter`, `utm_medium=email`, `utm_campaign=kw<WW>-<YYYY>`, `utm_content=artikel-N`).
- `newsletter/core.js` – Versandkern: `eligible()` ermittelt Empfänger ausschließlich aus den eigenen Blob-Einwilligungsdatensätzen (Vercel Blob Listing, keine Resend-Segmente — umgeht Segment-Limits des Marketing-Plans und schließt aus, dass eine Segment-Mitgliedschaft allein je zum Versand führt). Bedingungen: bestätigt (`confirmedAt`), nicht abgemeldet, `nlOptIn === true` (separate freiwillige Checkbox) und kein `nlUnsub[<site>]`. `sendAll()` (nur Template-Review-Einzelversand) verschickt mit pro-Empfänger-Abmeldelink (HMAC `nl-<site>`), `List-Unsubscribe` + `List-Unsubscribe-Post` Headern und 150 ms Staffelung. Absender ist fail-closed: ohne konfigurierte `IW_MAIL_FROM` / `FA_MAIL_FROM` wird nicht versendet (503 `sender-unresolved`), es gibt keinen Fallback auf andere Identitäten.

### Endpunkte (Rewrites in `vercel.json`)

- `GET /lw/api/nlweekly?site=<kifb|iw|fa>&date=YYYY-MM-DD&dry=1[&format=html]` – Trockenlauf: JSON-Vorschau (Empfängerzahl, Betreff, Artikel) bzw. HTML-Preview. Auth: Header `x-lw-auth = HMAC('nl:'+site+':'+date)`.
- `POST /lw/api/nlweekly?site=...&date=...` – Bulk-Versand als **Resend Broadcast** (Marketing-Rail) über `newsletter/dispatch.js`: Draft-first + Ownership per **Registry-CAS-Map**. Hintergrund: die Live-Probe (24.10.) hat gezeigt, dass der Blob-Store **kein atomares Create** kann (`x-allow-overwrite: 0` / `x-if-none-match` werden ignoriert), aber CAS funktioniert (`x-if-match` ETag, stale → 412, parallele CAS → genau 1 Gewinner). Deshalb schreibt die Laufzeit **niemals** einen Shared Key unconditional: es gibt genau eine vorab provisionierte Registry (`nl-registry/registry.json`, Map `issues[<site>-<date>]`), und jeder Claim/jede Transition ist ein bounded Read-Merge-CAS (412 → frisch lesen, neu mergen, retry). Parallele Claims **verschiedener** Ausgaben bleiben beide erhalten; parallele Claims **derselben** Ausgabe haben genau einen Gewinner. State-Maschine je Ausgabe: `claimed → draft → sending → sent | needs_review` (plus `failed-pre` = einziger übernehmbarer Zustand, Take-over via CAS). Send genau einmal pro Broadcast-ID, nur nach CAS in `sending` und frischem Provider-Status `draft`; mehrdeutiger Send → status-only Reconcile oder `needs_review`-**Hard-Stop**, nie Auto-Resend. Es gibt **keinen force-Parameter**; `already-sent`/`needs_review` sind terminal, Resets sind manuelle Operator-Entscheidungen (Issue-Key per CAS entfernen). `sent`-Tombstones werden **nie** gelöscht (sie verhindern Re-Send alter Ausgaben). Guard: < 3 Artikel → kein Versand. Fail-closed: ohne `NL_DISPATCH_ENABLED=1` **und** `NL_CAS_VERIFIED=1` (Live-Probe) sowie `NL_REGISTRY_URL` (offline provisioniert, kein Auto-Create) sowie `NL_SEGMENT_ID_*` **und** `NL_TOPIC_ID_*` (beide Pflicht, warten auf Freigabe) → 503. Abmeldung im Broadcast über `{{{RESEND_UNSUBSCRIBE_URL}}}` (Topic-scoped). Option `&to=<email>`: einzelner Template-Review-Versand (transaktional, pro-Empfänger-Abmeldelink), idempotent über `nl-log/`.
- `GET /lw/api/nlweekly?site=...&date=...&probe=1` – scoped Live-Probe gegen eine **wegwerfbare** Test-Registry unter `nl-probe/` (nie die Produktiv-Registry, nie Mail, Cleanup danach): P1 Provision erstellt+verifiziert, P2 Provision **verweigert** Überschreiben einer bestehenden Registry, P3 Read-after-Write + ETag, P4 aktuelles CAS erfolgt, P5 stale CAS → 412, P6 parallele CAS auf einem ETag → genau 1 Gewinner, P7 parallele Read-Merge-CAS auf verschiedene Issues → beide erhalten, P8 Delete → 404.
- `GET /lw/api/nlunsub?t=<token>` – One-Click-Abmeldung nur für den jeweiligen Wochen-Newsletter (setzt `nlUnsub[<site>]` im Opt-in-Datensatz; Tagesbericht-/PDF-Einwilligungen bleiben unberührt).

### API_URL und Link-Aufbau

Alle Links in Mails werden über `L.apiUrl('/lw/api/...')` gebaut (nie String-Konkatenation mit `L.API`). `apiUrl` normalisiert die `API_URL`-Formen: Bare-Host (`https://x.vercel.app`), Legacy mit trailing `/lw` (Produktion seit 20.10.) und optionaler trailing slash – immer genau ein `/lw` im Pfad, nie `/lw/lw/...`. Vertragstest: `test/nl-url-contract.test.js` (alle fünf DOI-Links + Abmeldelink unter allen Formen).

### Function-Budget (Vercel Hobby: max. 12 Funktionen)

Acht Funktionen gesamt: `confirm.js`, `subscribe.js`, `send-promo.js` sowie fünf Catch-all-Slots nach dem Muster `api/<slot>/[action].js` – `lw-atlas` (atlas*), `lw-iw` (iw*), `lw-fa` (fa*), `lw` (pdf/subscribe/tkdl/tksub/unsub/upload/confirm) und `nl` (weekly/unsub). Die Handler-Module liegen in `api/_atlas`, `api/_iw`, `api/_fa`, `api/_lwh`, `api/_nlh` (Unterstrich-Verzeichnisse zählen nicht als Funktionen). Alle öffentlichen Routen bleiben über die Rewrites in `vercel.json` unverändert erreichbar (`/lw/api/pdf` → `/api/lw/pdf` usw.; `/lw/api/nlweekly` → `/api/nl/weekly`, `/lw/api/nlunsub` → `/api/nl/unsub`).

### Env (Bulk-Dispatch; alle standardmäßig UNSET = deaktiviert, Freigabe ausstehend)

- `NL_DISPATCH_ENABLED=1` – Operator-Freigabe des Dispatch-Pfads.
- `NL_CAS_VERIFIED=1` – attestiert eine erfolgreiche Live-Probe (`?probe=1`, P1–P8) gegen eine wegwerfbare Registry im echten Blob-Store.
- `NL_REGISTRY_URL` / `NL_REGISTRY_KEY` – kanonische URL bzw. Key der **offline provisionierten** Dispatch-Registry. Einmaliges Setup bei deaktiviertem Dispatch: `node scripts/nl-registry-provision.js --init`. Der Provisioner schreibt **nie** über eine bestehende Registry: mit gesetzter URL wird nur inspiziert (unlesbare URL ⇒ Abbruch statt Blind-PUT); ohne URL (z. B. Env verloren) holt er zuerst einen **LIST-Absence-Proof** für den exakten Key ein – findet die Liste eine bestehende Registry, wird sie inspiziert statt überschrieben, und jeder Listen-Fehler/jede Pagination schlägt fail-closed fehl (kein Create ohne Absence-Proof). LIST ist nicht atomar: die Exklusivität des Setups bleibt eine operative Anforderung (einmalig, offline, bei deaktiviertem Dispatch). Es gibt keinen Online-Init-Endpunkt und kein Auto-Create: fehlende/unlesbare Registry ⇒ Dispatch fatal deaktiviert (`registry-missing`).
- `NL_SEGMENT_ID_KIFB|IW|FA` – ID eines **bestehenden** Segments pro Site (Audience-Pool; es werden nie Segmente erstellt).
- `NL_TOPIC_ID_KIFB|IW|FA` – ID des privaten Wochen-Topics pro Site (Pflicht: kein Broadcast ohne Topic-Scoping).
- Confirm-/Dispatch-Sync: Contact-Ensure ohne `unsubscribed`-Reset (globale Abmeldung bleibt immer erhalten), Segment-Join per ID, Topic `opt_in`/`opt_out` via `PATCH /contacts/{email}/topics`.
- Sync-Zustände pro Datensatz (`nlSync`): `applied` (Consent-Event beim Provider angewendet; Provider-Präferenzen gewinnen danach dauerhaft), `failed-pre` (vor jedem externen Call gescheitert, sicher retrybar), `unknown`/`attempting` (Ausgang unklar ⇒ `needs_review`, nie Blind-Retry), `undone-unsub`. **`undone-unsub` heißt: eine Abmeldung ist während eines laufenden Opt-ins eingeschlagen; das Opt-out wurde danach beim Provider nachgezogen, aber die betroffene Ausgabe pausiert als `needs_review` – die Wiederanlauf-Entscheidung ist ein manueller Operator-Schritt (Review, ggf. Reset), niemals ein automatischer Force-Rerun.** Es gibt keinen GET-Endpunkt für Topic-Zustände: eine PATCH-Akzeptanz gilt als „vom Provider angenommen“, nicht als beweisbarer Endzustand.

### Einwilligungsmodell (wichtig)

Versand nur an Kontakte, die den **Einwilligungstext v3** (oder den FA-Eröffnungstext) bestätigt haben:

- Der Wochenrückblick ist überall eine **separate, freiwillige Checkbox** (`nl`), keine Kopplung an Tagesbericht/PDF/Toolkit. Die Datensätze speichern `nlOptIn`; nur diese Datensätze sind versandberechtigt. Textversionen v4.
- KIFB Atlas bleibt ausdrücklich **ohne** Newsletter. IW: PDF-Zugang funktioniert auch ohne den Wochenrückblick.
- FA: neues, eigenes Anmeldeformular `/newsletter/` (vorher gab es gar keine E-Mail-Erfassung); dort ist der Newsletter das Produkt, eine Checkbox genügt.
- `lw-confirm.js` legt **keine** Resend-Segmente mehr für den Wochenrückblick an; die DOI-Mails nennen den Wochenrückblick nur, wenn er gewählt wurde. Bestandskontakte ohne `nlOptIn` erhalten **keinen** Wochen-Newsletter.
- Inhaltsauswahl: nur eigene Artikel (KIFB: Tagesanalysen bevorzugt, IW: `/artikel/` vor `/news/`, FA: nur `/artikel/`); aggregierte News-Seiten und Glossar-/Wissens-Updates füllen höchstens Restplätze.

### Wöchentlicher Versand (Publisher)

Sonntags (empfohlen 09:00 Europe/Berlin, finale Uhrzeit offen) pro Site:

```
HMAC = HMAC_SHA256(LW_SECRET, 'nl:' + SITE + ':' + DATE)   # DATE = Versandtag YYYY-MM-DD
curl -X POST 'https://daily-hob-newsletter.vercel.app/lw/api/nlweekly?site=kifb&date=2026-10-25' -H "x-lw-auth: $HMAC"
```

Vor dem ersten echten Versand: HTML-Preview per `dry=1&format=html` prüfen und Test-Versand per `&to=` an Philipp (Gmail + Outlook). Tests: `node --test test/*.test.js`.
