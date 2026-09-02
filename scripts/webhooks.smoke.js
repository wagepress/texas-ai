/**
 * Smoke test for the Twilio webhook endpoints (TwiML + status handling).
 * Needs a local MongoDB only. Run: node scripts/webhooks.smoke.js
 */
process.env.DB = process.env.DB || 'mongodb://localhost:27017/texas-ai-webhook-smoke'
process.env.PUBLIC_BASE_URL = 'https://example.test'
process.env.TWILIO_FROM_NUMBER = '+15550000000'
process.env.CALL_MAX_ATTEMPTS = '3'

const assert = require('assert')
const express = require('express')
const bodyParser = require('body-parser')
const mongoose = require('mongoose')

require('../mongoose')
require('../models/referral')
require('../models/callSession')
require('../models/emailMessage')
const { REFERRAL_STATUS, CALL_OUTCOMES } = require('../constants/referralStatus')

const app = express()
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(require('../routes/voice'))

const Referral = () => mongoose.model('referrals')
const CallSession = () => mongoose.model('callSessions')

async function post(base, path, form) {
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form || {}).toString(),
    })
    return { status: res.status, body: await res.text() }
}

async function main() {
    await mongoose.connection.asPromise()
    await mongoose.connection.dropDatabase()
    const server = app.listen(0)
    const base = `http://localhost:${server.address().port}`

    const referral = await Referral()({
        attachmentPath: '/x.pdf', status: REFERRAL_STATUS.CALLING,
        patient: { firstName: 'Bilal', lastName: 'Lalani', dob: '08/11/1993', primaryPhone: '832-384-2384' },
        studies: [{ description: 'MRI CERVICAL', sheetRow: 100 }],
        call: { attempts: 1, lastCallAt: new Date() },
    }).save()
    const session = await CallSession()({ referralId: referral._id, to: '+18323842384', twilioCallSid: 'CAxyz' }).save()

    // answer -> media stream TwiML pointing at our websocket
    const answer = await post(base, `/api/voice/answer?sessionId=${session._id}`, { CallSid: 'CAxyz' })
    assert.strictEqual(answer.status, 200)
    assert.ok(answer.body.includes('<Connect>'), answer.body)
    assert.ok(answer.body.includes(`wss://example.test/ws/voice/${session._id}`), answer.body)

    // answer with unknown session -> polite hangup
    const bad = await post(base, `/api/voice/answer?sessionId=${new mongoose.Types.ObjectId()}`, {})
    assert.ok(bad.body.includes('<Hangup/>'), bad.body)

    // AMD says human -> recorded, no outcome forced
    const amd = await post(base, `/api/voice/amd?sessionId=${session._id}`, { AnsweredBy: 'human', CallSid: 'CAxyz' })
    assert.strictEqual(amd.status, 200)
    let s = await CallSession().findById(session._id)
    assert.strictEqual(s.answeredBy, 'human')
    assert.strictEqual(s.outcome, '')

    // voicemail TwiML mentions the callback number and the patient
    const vm = await post(base, `/api/voice/voicemail?sessionId=${session._id}`, {})
    assert.ok(vm.body.includes('Texas Imaging Network'), vm.body)
    assert.ok(vm.body.includes('Bilal'), vm.body)

    // completed with no agent outcome -> incomplete -> retry scheduled
    const status = await post(base, `/api/voice/status?sessionId=${session._id}`, { CallStatus: 'completed', CallDuration: '42' })
    assert.strictEqual(status.status, 200)
    s = await CallSession().findById(session._id)
    assert.strictEqual(s.durationSec, 42)
    assert.strictEqual(s.outcome, CALL_OUTCOMES.INCOMPLETE)
    assert.strictEqual(s.outcomeDetail.finalized, true)
    const r = await Referral().findById(referral._id)
    assert.strictEqual(r.status, REFERRAL_STATUS.LOGGED, 'incomplete call goes back to retry')
    assert.ok(r.call.notes[0].startsWith('CALL DROPPED'), r.call.notes[0])

    // duplicate status callback is a no-op
    await post(base, `/api/voice/status?sessionId=${session._id}`, { CallStatus: 'completed' })
    const r2 = await Referral().findById(referral._id)
    assert.strictEqual(r2.call.notes.length, 1, 'no double note')

    server.close()
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
    console.log('webhooks.smoke: all assertions passed')
}

main().catch(async err => {
    console.error('webhooks.smoke FAILED:', err)
    process.exit(1)
})
