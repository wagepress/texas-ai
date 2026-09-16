const twilio = require('twilio')

/**
 * Twilio wrapper - outbound verification calls + reminder/missed-call SMS.
 * PUBLIC_BASE_URL must be the https origin Twilio can reach (e.g. an ngrok
 * URL in dev); the websocket stream URL is derived from it.
 */

let client = null

function isConfigured() {
    return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER)
}

function getClient() {
    if (!isConfigured()) {
        const err = new Error('Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.')
        err.statusCode = 503
        throw err
    }
    if (!client) client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    return client
}

function baseUrl() {
    const url = process.env.PUBLIC_BASE_URL
    if (!url) {
        const err = new Error('PUBLIC_BASE_URL is not set - Twilio webhooks cannot reach this server.')
        err.statusCode = 503
        throw err
    }
    return url.replace(/\/$/, '')
}

function streamUrl(callSessionId) {
    // sessionId travels in the path: Twilio strips query strings from stream URLs
    return `${baseUrl().replace(/^http/, 'ws')}/ws/voice/${callSessionId}`
}

/**
 * Place the outbound verification call. Async answering-machine detection
 * runs in parallel; when a machine picks up the AMD webhook swaps the call
 * to a voicemail message.
 */
function recordNumbers() {
    return (process.env.CALL_RECORD_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean)
}

async function startVerificationCall(to, callSessionId) {
    const call = await getClient().calls.create({
        to,
        from: process.env.TWILIO_FROM_NUMBER,
        url: `${baseUrl()}/api/voice/answer?sessionId=${callSessionId}`,
        method: 'POST',
        statusCallback: `${baseUrl()}/api/voice/status?sessionId=${callSessionId}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        machineDetection: 'Enable',
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${baseUrl()}/api/voice/amd?sessionId=${callSessionId}`,
        asyncAmdStatusCallbackMethod: 'POST',
        timeout: Number(process.env.CALL_RING_TIMEOUT_SEC || 30),
        timeLimit: Number(process.env.CALL_MAX_DURATION_SEC || 900),
        // audio-quality debugging only: record test numbers (never patients) with
        // caller and agent on separate channels
        ...(recordNumbers().includes(to) ? { record: true, recordingChannels: 'dual' } : {}),
    })
    return call
}

/** Hang up an in-progress call (agent goodbye, silence timeout). */
async function endCall(callSid) {
    await getClient().calls(callSid).update({ status: 'completed' })
}

/** Swap an in-progress call to the voicemail TwiML (used by the AMD webhook). */
async function redirectToVoicemail(callSid, callSessionId) {
    await getClient().calls(callSid).update({
        url: `${baseUrl()}/api/voice/voicemail?sessionId=${callSessionId}`,
        method: 'POST',
    })
}

async function sendSms(to, body) {
    return getClient().messages.create({ to, from: process.env.TWILIO_FROM_NUMBER, body })
}

/**
 * Optional webhook signature check (enable with TWILIO_VALIDATE_WEBHOOKS=true).
 * Off by default because proxies/tunnels frequently rewrite the URL.
 */
function validateWebhook(req) {
    if (process.env.TWILIO_VALIDATE_WEBHOOKS !== 'true') return true
    const signature = req.headers['x-twilio-signature']
    const url = `${baseUrl()}${req.originalUrl}`
    return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body || {})
}

module.exports = { isConfigured, getClient, startVerificationCall, redirectToVoicemail, endCall, sendSms, validateWebhook, streamUrl }
