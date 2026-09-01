const mongoose = require('mongoose')
const twilioService = require('../services/twilio')
const googleSheets = require('../services/googleSheets')
const { REFERRAL_STATUS, CALL_OUTCOMES } = require('../constants/referralStatus')
const { noteStamp, displayPhone } = require('./helpers')
const { withinCallHours, nextCallWindow } = require('./slots')
const { bestPhone } = require('./extractionEngine')

const Referral = () => mongoose.model('referrals')
const CallSession = () => mongoose.model('callSessions')

const MAX_ATTEMPTS = () => Number(process.env.CALL_MAX_ATTEMPTS || 3)
const RETRY_HOURS = () => Number(process.env.CALL_RETRY_HOURS || 4)
const STUCK_CALL_MINUTES = 30

async function appendSheetNote(referral, note) {
    const row = referral.sheet?.rows?.[0]
    if (!row || !googleSheets.isConfigured()) return
    await googleSheets.appendToCell(row, 'K', note).catch(err =>
        console.error('callScheduler: sheet note failed for row', row, err.message))
}

async function sendMissedCallSms(referral) {
    if (process.env.SMS_ON_MISSED_CALL !== 'true') return false
    const phone = bestPhone(referral)
    if (!phone) return false
    const callback = process.env.CLINIC_CALLBACK_NUMBER || process.env.TWILIO_FROM_NUMBER
    const body = `Texas Imaging Network: we are trying to reach ${referral.patient.firstName || 'you'} to schedule the imaging study ordered by your doctor. Please call us back at ${displayPhone(callback)}.`
    await twilioService.sendSms(phone, body)
    return true
}

/** Start one outbound verification call for a referral. */
async function initiateCall(referral) {
    const phone = bestPhone(referral)
    if (!phone) {
        referral.status = REFERRAL_STATUS.NEEDS_REVIEW
        referral.lastError = 'No dialable phone number'
        await referral.save()
        return null
    }
    const session = await CallSession()({
        referralId: referral._id,
        to: phone,
        from: process.env.TWILIO_FROM_NUMBER,
        startedAt: new Date(),
    }).save()

    try {
        const call = await twilioService.startVerificationCall(phone, session._id.toString())
        session.twilioCallSid = call.sid
        await session.save()
        referral.status = REFERRAL_STATUS.CALLING
        referral.call.attempts += 1
        referral.call.lastCallAt = new Date()
        await referral.save()
        console.log(`callScheduler: calling ${phone} for referral ${referral._id} (attempt ${referral.call.attempts})`)
        return session
    } catch (err) {
        console.error('callScheduler: could not start call for', referral._id.toString(), err.message)
        session.status = 'failed'
        session.error = err.message
        session.endedAt = new Date()
        await session.save()
        referral.status = REFERRAL_STATUS.LOGGED
        referral.call.nextCallAt = new Date(Date.now() + 30 * 60 * 1000)
        referral.lastError = err.message
        await referral.save()
        return null
    }
}

const OUTCOME_NOTE = {
    [CALL_OUTCOMES.VOICEMAIL]: 'LVM',
    [CALL_OUTCOMES.NO_ANSWER]: 'NVM',
    [CALL_OUTCOMES.BUSY]: 'BUSY',
    [CALL_OUTCOMES.FAILED]: 'CALL FAILED',
    [CALL_OUTCOMES.INCOMPLETE]: 'CALL DROPPED',
}

/**
 * Idempotent post-call bookkeeping. Every path that learns a call is over
 * (status webhook, AMD webhook, websocket close, stuck-call sweep) funnels
 * here; only the first caller wins.
 */
async function finalizeCall(callSessionId, outcome, detail = {}) {
    // atomic claim - the status webhook, AMD webhook, stream-close fallback and
    // stuck-call sweep can all race here; exactly one wins
    const session = await CallSession().findOneAndUpdate(
        { _id: callSessionId, 'outcomeDetail.finalized': { $ne: true } },
        { $set: { 'outcomeDetail.finalized': true } },
        { returnDocument: 'after' }
    )
    if (!session) return
    session.outcome = session.outcome || outcome
    session.outcomeDetail = { ...(session.outcomeDetail || {}), ...detail, finalized: true }
    session.endedAt = session.endedAt || new Date()
    await session.save()

    const referral = await Referral().findById(session.referralId)
    if (!referral) return
    const effective = session.outcome

    if (effective === CALL_OUTCOMES.SCHEDULED) {
        // book_appointment tool already wrote the sheet + referral fields
        referral.status = REFERRAL_STATUS.SCHEDULED
        referral.call.lastOutcome = effective
        await referral.save()
        return
    }

    if (effective === CALL_OUTCOMES.DECLINED) {
        referral.status = REFERRAL_STATUS.NEEDS_REVIEW
        referral.call.lastOutcome = effective
        const note = noteStamp('PT DECLINED SCHEDULING')
        referral.call.notes.push(note)
        await referral.save()
        await appendSheetNote(referral, note)
        return
    }

    if (effective === CALL_OUTCOMES.CALLBACK_REQUESTED) {
        referral.status = REFERRAL_STATUS.LOGGED
        referral.call.lastOutcome = effective
        referral.call.nextCallAt = nextCallWindow(new Date(Date.now() + 2 * 60 * 60 * 1000))
        const note = noteStamp('PT REQUESTED CALLBACK')
        referral.call.notes.push(note)
        await referral.save()
        await appendSheetNote(referral, note)
        return
    }

    // missed-call family: voicemail / no answer / busy / failed / dropped
    referral.call.lastOutcome = effective
    let noteText = OUTCOME_NOTE[effective] || 'CALL ENDED'
    const smsSent = await sendMissedCallSms(referral).catch(err => {
        console.error('callScheduler: sms failed', err.message)
        return false
    })
    if (smsSent) noteText += ', SENT SMS'

    if (referral.call.attempts >= MAX_ATTEMPTS()) {
        referral.status = REFERRAL_STATUS.UNREACHABLE
        noteText += ', MAX ATTEMPTS REACHED'
    } else {
        referral.status = REFERRAL_STATUS.LOGGED
        referral.call.nextCallAt = nextCallWindow(new Date(Date.now() + RETRY_HOURS() * 60 * 60 * 1000))
    }
    const note = noteStamp(noteText)
    referral.call.notes.push(note)
    await referral.save()
    await appendSheetNote(referral, note)
}

/** Referrals stuck in "calling" (crash mid-call, webhook lost) get retried. */
async function recoverStuckCalls() {
    const cutoff = new Date(Date.now() - STUCK_CALL_MINUTES * 60 * 1000)
    const stuck = await Referral().find({ status: REFERRAL_STATUS.CALLING, 'call.lastCallAt': { $lt: cutoff } })
    for (const referral of stuck) {
        const session = await CallSession().findOne({ referralId: referral._id }).sort({ createdAt: -1 })
        if (session && !session.outcomeDetail?.finalized) {
            await finalizeCall(session._id, CALL_OUTCOMES.INCOMPLETE, { reason: 'stuck call sweep' })
        } else {
            referral.status = REFERRAL_STATUS.LOGGED
            referral.call.nextCallAt = nextCallWindow()
            await referral.save()
        }
    }
}

async function tickOnce() {
    if (!twilioService.isConfigured() || !process.env.OPENAI_API_KEY) return
    await recoverStuckCalls()
    if (!withinCallHours()) return
    const due = await Referral().find({
        status: REFERRAL_STATUS.LOGGED,
        'call.nextCallAt': { $lte: new Date() },
        'call.attempts': { $lt: MAX_ATTEMPTS() },
    }).sort({ 'call.nextCallAt': 1 }).limit(Number(process.env.CALLS_PER_TICK || 2))
    for (const referral of due) await initiateCall(referral)
}

let running = false

function startCallScheduler() {
    const intervalMs = Number(process.env.CALL_SCHEDULER_INTERVAL_MS || 60 * 1000)
    const tick = async () => {
        if (running) return
        running = true
        try {
            await tickOnce()
        } catch (err) {
            console.error('callScheduler error:', err.message)
        } finally {
            running = false
        }
    }
    setInterval(tick, intervalMs)
    console.log(`callScheduler: running every ${intervalMs / 1000}s`)
}

module.exports = { startCallScheduler, tickOnce, initiateCall, finalizeCall, appendSheetNote }
