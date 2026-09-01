# texas-Ai

AI intake agent for Texas Imaging Network referrals. It watches an email
inbox for scanned patient slips, reads them with an OpenAI agent, logs every
ordered study into the online TIN log Google Sheet, then calls the patient
with a realtime voice agent (Twilio) to verify their info, run the MRI safety
screening, book the appointment and write the booking back onto the sheet.

## Pipeline

```
email (IMAP poll) ──► referral (status: received)
        │ attachment saved to uploads/
        ▼
OpenAI extraction agent (PDF/image -> structured slips)   status: extracted
        ▼
Google Sheet "TIN ALL" append, one row per study          status: logged
        ▼
Twilio outbound call -> media stream -> OpenAI realtime   status: calling
  agent verifies identity, screens, books a slot
        ▼
sheet updated: APPT DATE / APPT TIME / call note in K     status: scheduled
```

Misses are handled the way the front desk does it: voicemail (LVM note),
retry after `CALL_RETRY_HOURS` inside the calling window, optional SMS nudge,
and after `CALL_MAX_ATTEMPTS` the referral is parked as `unreachable` with a
note on the sheet. Slips the extractor cannot read confidently land in
`needs_review` for a human.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill it in:
   - **IMAP**: the intake mailbox (for Gmail create an App Password).
   - **OpenAI**: an API key with access to the extraction + realtime models.
   - **Google Sheets**: create a service account in Google Cloud, enable the
     Sheets API, download the key json, and share the spreadsheet with the
     service account's email as Editor. Set `GOOGLE_SHEET_ID` (the id in the
     sheet URL) and `GOOGLE_SHEET_TAB`.
   - **Twilio**: a voice-capable number. `PUBLIC_BASE_URL` must be an https
     URL that reaches this server (dev: `ngrok http 4000`).
   - **Mongo**: any MongoDB connection string in `DB`.
3. Optional: `npm run seed:sheet` writes the header row into an empty tab.
4. `npm start`

## Try it without email

- `node scripts/extractFile.js ~/Downloads/some-slip.pdf` runs the extraction
  agent on a local file and prints the structured slips.
- `npm run smoke:sheetrows` / `npm run smoke:slots` run the offline unit
  checks (no credentials needed).
- `npm run smoke:pipeline` / `npm run smoke:webhooks` run the end-to-end
  pipeline and Twilio-webhook checks with stubbed externals (needs only a
  local MongoDB).

## Admin API

All admin endpoints need the `x-api-key: <ADMIN_API_KEY>` header.

- `POST /api/referral/list` `{ page, limit, search, status }`
- `GET  /api/referral/detail/:id` – referral + its call sessions/transcripts
- `GET  /api/referral/stats` – counts by status
- `POST /api/referral/retry-extraction/:id` – requeue a `needs_review`/`failed` slip
- `POST /api/referral/call-now/:id` – dial the patient immediately
- `POST /api/referral/poll-email` – poll the mailbox right now
- `POST /api/call/list` – recent call sessions

Twilio webhooks (`/api/voice/answer|status|amd|voicemail`) are public; set
`TWILIO_VALIDATE_WEBHOOKS=true` once `PUBLIC_BASE_URL` is the exact public
origin to enforce signature checks.

## Sheet conventions reproduced

- One row per ordered study; extra rows for the same slip use `SA` and `-`
  exactly like the existing log.
- Column E is `DOB mm/dd/yyyy #phone [#phone2 ...]`, patient names are
  `LAST, FIRST`, referring doctors `LAST, FIRST`.
- Column K keeps the running call log with stamps like
  `LVM, SENT SMS-08/28/26-AI-CC//` (`AI` marks entries written by this
  service); the booking writes columns I (date) and J (time) on every study
  row.
- Defaults for INTAKE / BILLER / CAT / MONTH / UNITS / FC are configurable
  via `SHEET_*` env vars.
