# Daily Hob Newsletter API

Zwei Vercel-Funktionen (Region fra1) für die Double-Opt-In-Anmeldung auf https://hob.philipp-paulik.de.

- `POST /api/subscribe` nimmt `{ email, consent: true }` entgegen (Honeypot-Feld `website`, CORS nur Daily-Hob-Domain, einfaches Rate-Limit). Es wird nichts gespeichert. Die Funktion verschickt über Resend eine Bestätigungsmail mit signiertem Link (HMAC, 48 h gültig).
- `GET /api/confirm?token=...` prüft das Token, legt den Kontakt in Resend an (Segment "Daily Hob") und leitet auf `/newsletter/` weiter. Bereits vorhandene Kontakte werden nur dem Segment hinzugefügt, ihr globaler Status bleibt unberührt.

Umgebungsvariablen (nur in Vercel gesetzt): `RESEND_API_KEY`, `SEGMENT_ID`, `SECRET`.
