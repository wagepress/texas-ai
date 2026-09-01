const mongoose = require('mongoose')
const twilio = require('twilio')
const twilioService = require('../services/twilio')
const { finalizeCall } = require('../utils/callScheduler')
const { CALL_OUTCOMES } = require('../constants/referralStatus')
const { handleError, displayPhone } = require('../utils/helpers')

const CallSession = () => mongoose.model('callSessions')
const Referral = () => mongoose.model('referrals')

function sendTwiml(res, twiml) {
    res.type('text/xml').send(twiml.toString())
}

function rejectIfInvalid(req, res) {
    if (twilioService.validateWebhook(req)) return false
    res.status(403).send({ status: false, message: 'Invalid Twilio signature' })
    return true
}

module.exports = {
    /**
     * Twilio hits this when the outbound call is answered - respond with a
     * media stream that the realtime voice agent picks up in sockets/voiceStream.js
     */
    answer: async function (req, res) {
        try {
            if (rejectIfInvalid(req, res)) return
            const sessionId = req.query.sessionId
            const session = sessionId ? await CallSession().findById(sessionId) : null
            const twiml = new twilio.twiml.VoiceResponse()
            if (!session) {
                twiml.say('Sorry, this call cannot be completed.')
                twiml.hangup()
                return sendTwiml(res, twiml)
            }
            const connect = twiml.connect()
            const stream = connect.stream({ url: twilioService.streamUrl(sessionId) })
            stream.parameter({ name: 'sessionId', value: sessionId })
            sendTwiml(res, twiml)
        } catch (err) { handleError(res, err) }
    },

    /** Voicemail message played when answering-machine detection fires. */
    voicemail: async function (req, res) {
        try {
            if (rejectIfInvalid(req, res)) return
            const sessionId = req.query.sessionId
            const session = sessionId ? await CallSession().findById(sessionId) : null
            const referral = session ? await Referral().findById(session.referralId) : null
            const callback = displayPhone(process.env.CLINIC_CALLBACK_NUMBER || process.env.TWILIO_FROM_NUMBER)
            const name = referral?.patient?.firstName ? ` for ${referral.patient.firstName}` : ''
            const twiml = new twilio.twiml.VoiceResponse()
            twiml.pause({ length: 1 })
            twiml.say(`Hello, this is a message from Texas Imaging Network${name}. Your doctor has ordered an imaging study for you and we would like to schedule your appointment. Please call us back at ${callback}. Again, that number is ${callback}. Thank you.`)
            twiml.hangup()
            sendTwiml(res, twiml)
        } catch (err) { handleError(res, err) }
    },

    /** Async answering-machine-detection callback. */
    amd: async function (req, res) {
        try {
            if (rejectIfInvalid(req, res)) return
            const sessionId = req.query.sessionId
            const answeredBy = req.body.AnsweredBy || ''
            const callSid = req.body.CallSid
            const session = sessionId ? await CallSession().findById(sessionId) : null
            if (session) {
                session.answeredBy = answeredBy
                await session.save()
                if (/^machine/.test(answeredBy) || answeredBy === 'fax') {
                    session.outcome = CALL_OUTCOMES.VOICEMAIL
                    await session.save()
                    await twilioService.redirectToVoicemail(callSid, sessionId)
                        .catch(err => console.error('voice.amd: redirect failed', err.message))
                }
            }
            res.send({ status: true, message: 'ok' })
        } catch (err) { handleError(res, err) }
    },

    /** Call status callback - the authoritative "call is over" signal. */
    status: async function (req, res) {
        try {
            if (rejectIfInvalid(req, res)) return
            const sessionId = req.query.sessionId
            const callStatus = req.body.CallStatus || ''
            const session = sessionId ? await CallSession().findById(sessionId) : null
            if (session) {
                session.status = callStatus
                if (req.body.CallDuration) session.durationSec = Number(req.body.CallDuration)
                await session.save()
                if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
                    const outcomeByStatus = {
                        busy: CALL_OUTCOMES.BUSY,
                        'no-answer': CALL_OUTCOMES.NO_ANSWER,
                        failed: CALL_OUTCOMES.FAILED,
                        canceled: CALL_OUTCOMES.NO_ANSWER,
                    }
                    // for "completed": keep whatever the agent/AMD already set, else the
                    // call ended without a booking -> incomplete
                    const outcome = outcomeByStatus[callStatus] || session.outcome || CALL_OUTCOMES.INCOMPLETE
                    await finalizeCall(session._id, outcome, { twilioStatus: callStatus })
                }
            }
            res.send({ status: true, message: 'ok' })
        } catch (err) { handleError(res, err) }
    },
}
