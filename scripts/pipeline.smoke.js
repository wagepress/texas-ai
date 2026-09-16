/**
 * Integration smoke test for the whole pipeline with stubbed externals
 * (OpenAI, Google Sheets, Twilio). Needs a local MongoDB only.
 * Run: node scripts/pipeline.smoke.js
 */
process.env.DB = process.env.DB || 'mongodb://localhost:27017/texas-ai-pipeline-smoke'
process.env.TWILIO_ACCOUNT_SID = 'ACtest'
process.env.TWILIO_AUTH_TOKEN = 'test'
process.env.TWILIO_FROM_NUMBER = '+15550000000'
process.env.PUBLIC_BASE_URL = 'https://example.test'
process.env.OPENAI_API_KEY = 'sk-test'
process.env.CALL_HOURS_START = '0'
process.env.CALL_HOURS_END = '24'
process.env.CALL_MAX_ATTEMPTS = '2'
process.env.SMS_ON_MISSED_CALL = 'true'

const assert = require('assert')
const mongoose = require('mongoose')

// ---- stub the three external services before anything requires them ----
const sheetCalls = { appended: [], updated: [], notes: [] }
let nextRow = 100
require.cache[require.resolve('../services/googleSheets')] = {
    exports: {
        isConfigured: () => true,
        spreadsheetId: () => 'sheet-test',
        tabName: () => 'TIN ALL',
        appendRows: async (values) => { const first = nextRow; sheetCalls.appended.push(values); nextRow += values.length; return first },
        updateCells: async (cells) => { sheetCalls.updated.push(...cells) },
        appendToCell: async (row, column, text) => { sheetCalls.notes.push({ row, column, text }); return text },
        getCell: async () => '',
        getHeaderRow: async () => [],
    },
}
const twilioCalls = { calls: [], sms: [] }
require.cache[require.resolve('../services/twilio')] = {
    exports: {
        isConfigured: () => true,
        startVerificationCall: async (to, sessionId) => { twilioCalls.calls.push({ to, sessionId }); return { sid: `CA${twilioCalls.calls.length}` } },
        redirectToVoicemail: async () => { },
        sendSms: async (to, body) => { twilioCalls.sms.push({ to, body }) },
        validateWebhook: () => true,
        streamUrl: (id) => `wss://example.test/ws/voice?sessionId=${id}`,
        getClient: () => { throw new Error('not needed in smoke') },
    },
}
const fakeSlips = {
    slips: [
        {
            patient: {
                firstName: 'Bilal', lastName: 'Lalani', dob: '08/11/1993', ssn: null,
                primaryPhone: '(832) 384-2384', secondaryPhone: null, alternatePhone: null,
                insuredName: 'Dhanani Law PLLC', insuranceName: null, planName: null, memberId: null, groupNumber: null,
            },
            attorney: 'Dhanani Law PLLC',
            doctor: { name: 'Dr. Ruben Munguia', phone: '(832) 437-3414', fax: null, email: null, npi: null },
            facility: 'I-10', clinicalFindings: 'M54.12 Radiculopathy Cervical', stat: false,
            claustrophobic: null, sedation: null, slipDate: '06/10/2026', comments: null, specialInstructions: null,
            studies: [
                { description: 'MRI CERVICAL', cpt: '72141', laterality: null, contrast: 'W/O' },
                { description: 'MRI LUMBAR', cpt: '72148', laterality: null, contrast: 'W/O' },
            ],
            confidence: 'high', notes: null,
        },
        {
            patient: {
                firstName: 'Mehak', lastName: 'Lalani', dob: '10/12/1991', ssn: null,
                primaryPhone: null, secondaryPhone: null, alternatePhone: null,
                insuredName: null, insuranceName: null, planName: null, memberId: null, groupNumber: null,
            },
            attorney: null, doctor: { name: null, phone: null, fax: null, email: null, npi: null },
            facility: null, clinicalFindings: null, stat: false, claustrophobic: null, sedation: null,
            slipDate: null, comments: null, specialInstructions: null,
            studies: [{ description: 'MRI RT SHOULDER', cpt: '73221', laterality: 'RT', contrast: null }],
            confidence: 'high', notes: null,
        },
    ],
}
require.cache[require.resolve('../services/openaiClient')] = {
    exports: {
        ensureConfigured: () => { },
        extractSlipsFromFile: async () => JSON.parse(JSON.stringify(fakeSlips)),
    },
}

require('../mongoose')
require('../models/referral')
require('../models/callSession')
require('../models/emailMessage')
const { REFERRAL_STATUS, CALL_OUTCOMES } = require('../constants/referralStatus')
const { extractPending, logPending } = require('../utils/extractionEngine')
const { tickOnce, finalizeCall } = require('../utils/callScheduler')
const { buildTools } = require('../sockets/voiceStream')

const Referral = () => mongoose.model('referrals')
const CallSession = () => mongoose.model('callSessions')

async function main() {
    await mongoose.connection.asPromise()
    await mongoose.connection.dropDatabase()

    // 1. an email attachment arrives (poller output simulated)
    // the file only exists in the DB copy (saved by another instance / before a deploy)
    const fakePath = require('path').join(require('os').tmpdir(), `texas-smoke-${Date.now()}`, 'fake.pdf')
    const seed = await Referral()({
        emailMessageId: '<smoke@test>', emailSubject: 'Frontdesk Scans', emailFrom: 'frontdesk@clinic.com',
        attachmentPath: fakePath, attachmentName: 'fake.pdf', attachmentMime: 'application/pdf',
        attachmentData: Buffer.from('%PDF-smoke'),
    }).save()
    assert.strictEqual((await Referral().findById(seed._id)).attachmentData, undefined, 'bytes not loaded by default')

    // 2. extraction: 1 attachment -> 2 slips
    await extractPending()
    assert.strictEqual(require('fs').readFileSync(fakePath, 'utf8'), '%PDF-smoke', 'attachment restored from the DB copy')
    const all = await Referral().find().sort({ createdAt: 1 })
    assert.strictEqual(all.length, 2, 'second slip became a sibling referral')
    assert.strictEqual(all[0].status, REFERRAL_STATUS.EXTRACTED)
    assert.strictEqual(all[0].studies.length, 2)
    assert.strictEqual(all[1].patient.firstName, 'Mehak')

    // 3. sheet logging: slip 1 (has phone) -> logged; slip 2 (no phone) -> needs_review
    await logPending()
    await logPending()
    const [r1, r2] = await Referral().find().sort({ createdAt: 1 })
    assert.strictEqual(r1.status, REFERRAL_STATUS.LOGGED)
    assert.deepStrictEqual(r1.sheet.rows, [100, 101], 'two study rows tracked')
    assert.strictEqual(r1.studies[1].sheetRow, 101)
    assert.strictEqual(r2.status, REFERRAL_STATUS.NEEDS_REVIEW, 'no phone -> needs_review')
    assert.ok(r2.extractionNotes.includes('No dialable phone'), r2.extractionNotes)
    assert.strictEqual(sheetCalls.appended.length, 2)
    assert.strictEqual(sheetCalls.appended[0].length, 2, 'first append has 2 rows')

    // duplicate protection: re-extracting the same slip must not double-log
    const dupe = await Referral()({
        attachmentPath: '/tmp/fake2.pdf', attachmentName: 'fake2.pdf', attachmentMime: 'application/pdf',
        status: REFERRAL_STATUS.EXTRACTED,
        patient: r1.patient, studies: r1.studies.map(st => ({ description: st.description })),
    }).save()
    await logPending()
    const dupeAfter = await Referral().findById(dupe._id)
    assert.strictEqual(dupeAfter.status, REFERRAL_STATUS.NEEDS_REVIEW, 'duplicate flagged for review')
    assert.ok(dupeAfter.extractionNotes.includes('duplicate'), dupeAfter.extractionNotes)

    // 4. call scheduler dials the logged referral
    await tickOnce()
    let called = await Referral().findById(r1._id)
    assert.strictEqual(called.status, REFERRAL_STATUS.CALLING)
    assert.strictEqual(called.call.attempts, 1)
    assert.strictEqual(twilioCalls.calls.length, 1)
    assert.strictEqual(twilioCalls.calls[0].to, '+18323842384')
    let session = await CallSession().findOne({ referralId: r1._id })
    assert.strictEqual(session.twilioCallSid, 'CA1')

    // 5. voicemail outcome -> LVM note, SMS, retry scheduled
    await finalizeCall(session._id, CALL_OUTCOMES.VOICEMAIL)
    await finalizeCall(session._id, CALL_OUTCOMES.NO_ANSWER) // second finalize must be a no-op
    called = await Referral().findById(r1._id)
    assert.strictEqual(called.status, REFERRAL_STATUS.LOGGED, 'back to logged for retry')
    assert.ok(called.call.nextCallAt > new Date(), 'retry in the future')
    assert.strictEqual(called.call.notes.length, 1, 'idempotent finalize wrote exactly one note')
    assert.ok(called.call.notes[0].startsWith('LVM, SENT SMS'), called.call.notes[0])
    assert.strictEqual(twilioCalls.sms.length, 1)
    assert.ok(sheetCalls.notes.some(n => n.row === 100 && n.column === 'K' && n.text.startsWith('LVM')))

    // 6. second attempt: the realtime agent's tools verify + book
    called.call.nextCallAt = new Date(Date.now() - 1000)
    await called.save()
    await tickOnce()
    session = await CallSession().findOne({ referralId: r1._id }).sort({ createdAt: -1 })
    assert.strictEqual(twilioCalls.calls.length, 2)

    const tools = buildTools(r1._id.toString(), session._id.toString())
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))
    assert.deepStrictEqual(Object.keys(byName).sort(),
        ['book_appointment', 'check_date_of_birth', 'end_call', 'get_available_slots', 'record_screening', 'record_verification', 'save_call_outcome'])

    const slots = JSON.parse(await byName.get_available_slots.invoke({}, '{}'))
    assert.ok(slots.length >= 3, 'slots offered')

    // r1's DOB on file is 08/11/1993; any spoken format must match, a different date must not end the call
    const dobOk = await byName.check_date_of_birth.invoke({}, JSON.stringify({ stated_dob: 'August 11th, 93' }))
    assert.ok(String(dobOk).startsWith('match'), dobOk)
    const dobOff = await byName.check_date_of_birth.invoke({}, JSON.stringify({ stated_dob: '8/12/1993' }))
    assert.ok(String(dobOff).startsWith('mismatch') && String(dobOff).includes('NOT a wrong number'), dobOff)

    await byName.record_verification.invoke({}, JSON.stringify({
        identity_confirmed: true, dob_matches: true, corrected_phone: null, corrected_dob: null, notes: null,
    }))
    await byName.record_screening.invoke({}, JSON.stringify({
        had_mri_before: 'yes', claustrophobic: 'no', metal_implants: 'no', pacemaker: 'no',
        prior_surgeries: 'no', height: `5'8`, weight: '180lbs', notes: null,
    }))

    const rejected = await byName.book_appointment.invoke({}, JSON.stringify({ date: '01/01/2020', time: '10:00AM' }))
    assert.ok(String(rejected).startsWith('CANNOT BOOK'), rejected)

    const slot = slots[0]
    const booked = await byName.book_appointment.invoke({}, JSON.stringify({ date: slot.date, time: slot.time }))
    assert.ok(String(booked).startsWith('BOOKED'), booked)

    // 7. call completes -> finalize keeps the scheduled outcome
    await finalizeCall(session._id, CALL_OUTCOMES.INCOMPLETE, { twilioStatus: 'completed' })
    const done = await Referral().findById(r1._id)
    assert.strictEqual(done.status, REFERRAL_STATUS.SCHEDULED)
    assert.strictEqual(done.call.verified, true)
    assert.strictEqual(done.call.appointmentDate, slot.date)
    assert.strictEqual(done.call.screening.claustrophobic, 'no')
    const apptCells = sheetCalls.updated.filter(c => ['I', 'J'].includes(c.column))
    assert.strictEqual(apptCells.length, 4, 'date+time written on both study rows')
    assert.ok(sheetCalls.notes.some(n => n.text.includes('PT SCH') && n.text.includes('NO CLAUS')), 'booking note on the sheet')

    // 8. max attempts -> unreachable
    const r3 = await Referral()({
        attachmentPath: '/x.pdf', status: REFERRAL_STATUS.LOGGED,
        patient: { firstName: 'Max', lastName: 'Attempts', dob: '01/01/1990', primaryPhone: '832-555-1111' },
        studies: [{ description: 'MRI CERVICAL' }],
        sheet: { spreadsheetId: 's', tab: 't', rows: [500] },
        call: { attempts: 2, nextCallAt: new Date(Date.now() - 1000) },
    }).save()
    const s3 = await CallSession()({ referralId: r3._id, to: '+18325551111' }).save()
    await finalizeCall(s3._id, CALL_OUTCOMES.NO_ANSWER)
    const r3After = await Referral().findById(r3._id)
    assert.strictEqual(r3After.status, REFERRAL_STATUS.UNREACHABLE)
    assert.ok(r3After.call.notes[0].includes('MAX ATTEMPTS'), r3After.call.notes[0])

    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
    console.log('pipeline.smoke: all assertions passed')
}

main().catch(async err => {
    console.error('pipeline.smoke FAILED:', err)
    await mongoose.disconnect().catch(() => { })
    process.exit(1)
})
