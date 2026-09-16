# texas-Ai conventions

This project mirrors the workforce-api house style:

- Plain JavaScript, CommonJS, no build step. 4-space indent, no semicolons,
  single quotes.
- Flat layout: `controllers/`, `routes/`, `models/`, `middlewares/`,
  `services/`, `utils/`, `sockets/`, `scripts/`. No `src/`.
- Models register by side effect (`mongoose.model('name', schema)`, no
  export) and are required once in `index.js`. Controllers fetch them with
  `mongoose.model('name')`.
- Routers own their full `/api/...` paths and are mounted with
  `app.use(require('./routes/x'))`.
- Every controller handler is `async`, wrapped in try/catch ending in
  `handleError(res, err)` from `utils/helpers.js`; responses are always
  `{ status: bool, message, data? }` via `res.send`.
- Third-party SDKs get one wrapper in `services/<name>.js` with a lazily
  initialized module-level client; missing config throws an Error with
  `statusCode: 503`. Background work lives in `utils/` as `startXxx()`
  functions driven by `setInterval` with an overlap guard, and no-ops when
  its env vars are absent.
- Logging is plain `console.log` / `console.error`.

Domain notes:

- The referral status machine is documented in
  `constants/referralStatus.js`; every transition happens either in
  `utils/extractionEngine.js` or `utils/callScheduler.js#finalizeCall`
  (idempotent - all "call ended" signals funnel there).
- Sheet column layout lives only in `utils/sheetRows.js`. If the clinic
  changes the workbook, change it there and in the smoke test.
- The realtime voice agent (instructions + tools) lives in
  `sockets/voiceStream.js`; booking validation is `utils/slots.js`.
- DOB parsing/matching (any spoken format, stored as MM/DD/YYYY) is
  `utils/dob.js`; the agent never compares dates itself.
- Offline checks: `npm run smoke:sheetrows`, `npm run smoke:slots`,
  `npm run smoke:dob`. Live
  extraction check: `node scripts/extractFile.js <file>`.
