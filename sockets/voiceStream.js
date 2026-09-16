const { WebSocketServer } = require('ws')
const mongoose = require('mongoose')
const { z } = require('zod')
const { RealtimeAgent, RealtimeSession, tool, backgroundResult } = require('@openai/agents/realtime')
const { TwilioRealtimeTransportLayer } = require('@openai/agents-extensions')
const googleSheets = require('../services/googleSheets')
const twilioService = require('../services/twilio')
const { suggestSlots, validateSlot } = require('../utils/slots')
const { finalizeCall } = require('../utils/callScheduler')
const { CALL_OUTCOMES, REFERRAL_STATUS } = require('../constants/referralStatus')
const { noteStamp, displayPhone } = require('../utils/helpers')
const { formatDob, spokenDob, compareDob } = require('../utils/dob')

const Referral = () => mongoose.model('referrals')
const CallSession = () => mongoose.model('callSessions')

function agentInstructions(referral) {
    const patientFirst = referral.patient.firstName || 'the patient'
    const fullName = `${referral.patient.firstName} ${referral.patient.lastName}`.trim()
    const studies = referral.studies.map(st => st.description).join(', ')
    const hasMri = referral.studies.some(st => /^MR/.test(st.description))
    const callback = displayPhone(process.env.CLINIC_CALLBACK_NUMBER || process.env.TWILIO_FROM_NUMBER || '')
    const dob = referral.patient.dob ? `${formatDob(referral.patient.dob)} (${spokenDob(referral.patient.dob)})` : 'unknown'

    return `You are a warm, friendly scheduling coordinator calling on behalf of Texas Imaging Network, a network of medical imaging centers in the Houston area. You are on a live phone call with a patient. Talk like a real person on the phone: relaxed, conversational, use contractions and short acknowledgements ("Perfect", "Got it", "Great, thank you"), keep each turn to one or two short sentences, and ask one question at a time. Don't sound scripted and don't repeat the same phrase twice in a row. Never mention that you are an AI unless directly asked; if asked, answer honestly that you are an automated scheduling assistant.

Details for this call (do NOT read these out loud verbatim; use them to verify):
- Patient: ${fullName || 'unknown'}, date of birth ${dob}
- Phone on file: ${displayPhone(referral.patient.primaryPhone) || 'unknown'}
- Referring doctor: ${referral.doctor.name || 'their doctor'}
- Ordered studies: ${studies || 'imaging studies'}
- Facility on the order: ${referral.facility || 'not specified'}
- Diagnosis on the slip: ${referral.clinicalFindings || 'not specified'}
${referral.attorney ? `- The referral came through their attorney/case: ${referral.attorney}` : ''}

Call flow:
1. Greet, say you are calling from Texas Imaging Network about the imaging study their doctor ${referral.doctor.name || ''} ordered, and ask if you are speaking with ${patientFirst}.
2. It is a wrong number ONLY if the person clearly says they are not ${patientFirst} and don't know them (or there is no such person at this number). In that case apologize, call save_call_outcome with outcome "wrong_number", say goodbye and call end_call. If someone else answers but knows the patient, ask for the patient or a good time to call back instead.
3. Verify identity: ask them to confirm their date of birth. People say dates in many ways ("8/11/93", "August eleventh, ninety-three", "the 11th of August 1993", day-first, etc.) - ALL of these are fine. Never judge the date yourself: pass what they said to check_date_of_birth and follow its answer.
   - match: thank them and move on.
   - unclear: casually ask them to say it again, e.g. "Sorry, could you give me the month, day and year?"
   - mismatch: read back what you heard in plain words ("I have August 11th, 1993 - is that right?"). If they confirm their own date, accept it as a correction to our records and continue.
   A date-of-birth problem is NEVER a wrong number and never a reason to end the call.
   Then confirm the best callback phone number. Record everything with ONE record_verification call.
4. ${hasMri ? `MRI safety screening - ask the questions one at a time and just keep the answers in mind. Call record_screening ONCE, together with your next sentence, after the last answer - never after each question:
   - Have they had an MRI before?
   - Are they claustrophobic?
   - Any metal implants, plates, screws, or metal fragments in their body or eyes?
   - Do they have a pacemaker, neurostimulator, or inner-ear implant?
   - Any surgeries or procedures related to the injury?
   - Their approximate height and weight.` : 'Ask if they have any relevant prior surgeries or procedures and record with record_screening.'}
5. Scheduling: say something like "Let me check what we have open" while you call get_available_slots, offer two or three options, and agree on one. If they want a different day/time, ask for it and try book_appointment - it validates the request and tells you if the office is closed. Say "One moment while I book that" as you call book_appointment. Once it returns success, repeat the confirmed date and time back to them.
6. If they refuse to schedule, call save_call_outcome with outcome "declined". If they ask to be called back later, use outcome "callback_requested".
7. Close: remind them ${hasMri ? 'not to wear metal and ' : ''}to arrive 15 minutes early with a photo ID, tell them our number is ${callback} if anything changes, thank them, say goodbye, and call end_call.

Rules:
- Do not give medical advice or discuss results, costs, insurance or legal matters. For such questions say the front desk at ${callback} can help, and note it in the outcome summary.
- If the patient corrects the name, birth date or phone we have on file, record the correction with record_verification (dates always as MM/DD/YYYY).
- Filler sounds ("uh", "um", "hello?", a single word in another language) are not answers. Never record a screening answer you didn't clearly hear - ask the question again in simpler words.
- Background sounds are not the patient: TV, radio, other people talking in the room, or speech that has nothing to do with your question. Ignore them - don't answer them or record them - and if you can't tell, briefly repeat your question.
- Never go silent while a tool runs: say a short natural phrase in the same turn ("Got it", "One moment").
- If the patient interrupts you, stop and listen; don't restart your whole sentence, just continue from what they said.
- After you call end_call, do not say anything else.
- Say dates the way people do ("Tuesday, August 11th at 10 AM", "August 11th, 1993"), never as digits or slashes.
- Always call save_call_outcome (or complete book_appointment) before the call ends so nothing is lost.
- The line does NOT disconnect on its own: every conversation ends with you saying goodbye and then calling end_call - after booking, after a decline, after a wrong number, or when the patient stops responding.`
}

/** "PT SCH, YES MRI, NO CLAUS, NO METAL, NO SURG, 5'4 140LBS" style booking note */
function bookingNote(screening = {}, date, time) {
    const yn = (value, label) => {
        if (value == null || value === '') return null
        const truthy = /^(y|yes|true)/i.test(String(value))
        return `${truthy ? 'YES' : 'NO'} ${label}`
    }
    const pieces = [`PT SCH ${date} ${time}`]
    const mapped = [
        yn(screening.had_mri_before, 'PRIOR MRI'),
        yn(screening.claustrophobic, 'CLAUS'),
        yn(screening.metal_implants, 'METAL'),
        yn(screening.pacemaker, 'PACEMAKER'),
        yn(screening.prior_surgeries, 'SURG'),
    ].filter(Boolean)
    pieces.push(...mapped)
    if (screening.height || screening.weight) pieces.push(`${screening.height || ''} ${screening.weight || ''}`.trim().toUpperCase())
    return pieces.join(', ')
}

function buildTools(referralId, callSessionId) {
    const getAvailableSlots = tool({
        name: 'get_available_slots',
        description: 'List appointment slots that can be offered to the patient.',
        parameters: z.object({}),
        execute: async () => JSON.stringify(suggestSlots(6)),
    })

    const checkDateOfBirth = tool({
        name: 'check_date_of_birth',
        description: 'Check the date of birth the patient gave against the one on file. Accepts any format; pass MM/DD/YYYY when you can, otherwise their words as said.',
        parameters: z.object({
            stated_dob: z.string().describe('What the patient said, e.g. "08/11/1993" or "August 11 1993"'),
        }),
        execute: async (input) => {
            const referral = await Referral().findById(referralId)
            if (!referral) return 'referral not found'
            const check = compareDob(input.stated_dob, referral.patient.dob)
            if (check.result === 'match') return 'match - date of birth confirmed'
            if (check.result === 'no_dob_on_file') return `no_dob_on_file - accept what they said and record it as corrected_dob (${formatDob(input.stated_dob)})`
            if (check.result === 'unclear') return 'unclear - could not understand that date; politely ask for month, day and year again'
            return `mismatch - you heard ${spokenDob(check.heard)} (${check.heard}). Read it back to confirm; if they confirm, record it as corrected_dob and continue. This is NOT a wrong number.`
        },
    })

    const recordVerification = tool({
        name: 'record_verification',
        description: 'Record the result of the identity check and any corrected contact info.',
        parameters: z.object({
            identity_confirmed: z.boolean(),
            dob_matches: z.boolean().nullable(),
            corrected_phone: z.string().nullable(),
            corrected_dob: z.string().nullable().describe('MM/DD/YYYY'),
            notes: z.string().nullable(),
        }),
        execute: async (input) => {
            const referral = await Referral().findById(referralId)
            if (!referral) return 'referral not found'
            referral.call.verified = input.identity_confirmed
            referral.call.correctedInfo = {
                ...(referral.call.correctedInfo || {}),
                ...(input.corrected_phone ? { phone: input.corrected_phone } : {}),
                ...(input.corrected_dob ? { dob: formatDob(input.corrected_dob) } : {}),
                ...(input.notes ? { verificationNotes: input.notes } : {}),
                dobMatches: input.dob_matches,
            }
            referral.markModified('call.correctedInfo')
            await referral.save()
            return 'recorded'
        },
    })

    const recordScreening = tool({
        name: 'record_screening',
        description: 'Record the patient safety-screening answers.',
        parameters: z.object({
            had_mri_before: z.string().nullable(),
            claustrophobic: z.string().nullable(),
            metal_implants: z.string().nullable(),
            pacemaker: z.string().nullable(),
            prior_surgeries: z.string().nullable(),
            height: z.string().nullable(),
            weight: z.string().nullable(),
            notes: z.string().nullable(),
        }),
        execute: async (input) => {
            const referral = await Referral().findById(referralId)
            if (!referral) return 'referral not found'
            const cleaned = Object.fromEntries(Object.entries(input).filter(([, value]) => value != null && value !== ''))
            referral.call.screening = { ...(referral.call.screening || {}), ...cleaned }
            referral.markModified('call.screening')
            await referral.save()
            return 'recorded'
        },
    })

    const bookAppointment = tool({
        name: 'book_appointment',
        description: 'Book the appointment once the patient agrees on a date and time. Validates the slot; returns success or the reason it cannot be booked.',
        parameters: z.object({
            date: z.string().describe('MM/DD/YYYY'),
            time: z.string().describe('e.g. "10:00AM"'),
        }),
        execute: async (input) => {
            const check = validateSlot(input.date, input.time)
            if (!check.valid) return `CANNOT BOOK: ${check.reason}`
            const referral = await Referral().findById(referralId)
            if (!referral) return 'referral not found'
            referral.call.appointmentDate = check.date
            referral.call.appointmentTime = check.time
            referral.status = REFERRAL_STATUS.SCHEDULED
            const note = noteStamp(bookingNote(referral.call.screening, check.date, check.time))
            referral.call.notes.push(note)
            await referral.save()

            const session = await CallSession().findById(callSessionId)
            if (session) {
                session.outcome = CALL_OUTCOMES.SCHEDULED
                session.outcomeDetail = { ...(session.outcomeDetail || {}), appointmentDate: check.date, appointmentTime: check.time }
                await session.save()
            }

            // write APPT DATE / APPT TIME on every study row + the booking note on the first.
            // Not awaited: the Sheets API takes 1-2s and the patient would hear silence.
            if (googleSheets.isConfigured() && referral.sheet?.rows?.length) {
                const cells = []
                for (const row of referral.sheet.rows) {
                    cells.push({ row, column: 'I', value: check.date })
                    cells.push({ row, column: 'J', value: check.time })
                }
                const firstRow = referral.sheet.rows[0]
                googleSheets.updateCells(cells)
                    .catch(err => console.error('voiceStream: sheet appt update failed', err.message))
                    .then(() => googleSheets.appendToCell(firstRow, 'K', note))
                    .catch(err => console.error('voiceStream: sheet note failed', err.message))
            }
            console.log(`voiceStream: booked ${check.date} ${check.time} for referral ${referralId}`)
            return `BOOKED: ${check.spoken}. Confirm this with the patient.`
        },
    })

    const saveCallOutcome = tool({
        name: 'save_call_outcome',
        description: 'Save the final result of the call when it ends WITHOUT a booking (wrong number, declined, callback requested, or anything unusual).',
        parameters: z.object({
            outcome: z.enum(['wrong_number', 'declined', 'callback_requested', 'other']),
            summary: z.string(),
        }),
        execute: async (input) => {
            const session = await CallSession().findById(callSessionId)
            if (!session) return 'session not found'
            const map = {
                wrong_number: CALL_OUTCOMES.FAILED,
                declined: CALL_OUTCOMES.DECLINED,
                callback_requested: CALL_OUTCOMES.CALLBACK_REQUESTED,
                other: CALL_OUTCOMES.INCOMPLETE,
            }
            session.outcome = map[input.outcome]
            session.outcomeDetail = { ...(session.outcomeDetail || {}), agentOutcome: input.outcome, summary: input.summary }
            await session.save()
            if (input.outcome === 'wrong_number') {
                const referral = await Referral().findById(referralId)
                if (referral) {
                    const note = noteStamp('WRONG NUMBER')
                    referral.call.notes.push(note)
                    referral.status = REFERRAL_STATUS.NEEDS_REVIEW
                    await referral.save()
                }
            }
            return 'saved'
        },
    })

    const endCall = tool({
        name: 'end_call',
        description: 'Hang up the phone line. Call this AFTER you have said goodbye; the audio finishes playing before the line drops.',
        parameters: z.object({}),
        execute: async () => {
            const session = await CallSession().findById(callSessionId)
            if (!session?.twilioCallSid) return 'no active call to hang up'
            // small grace period so the goodbye audio reaches the patient
            setTimeout(() => {
                twilioService.endCall(session.twilioCallSid).catch(err =>
                    console.error('voiceStream: hangup failed', err.message))
            }, 4 * 1000)
            // background result: no follow-up response, so nothing is spoken after the goodbye
            return backgroundResult('hanging up')
        },
    })

    return [getAvailableSlots, checkDateOfBirth, recordVerification, recordScreening, bookAppointment, saveCallOutcome, endCall]
}

function extractTranscript(item) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) return null
    const text = item.content
        .map(part => part?.transcript || part?.text || '')
        .filter(Boolean)
        .join(' ')
        .trim()
    return text ? { role: item.role, text } : null
}

async function handleConnection(twilioWebSocket, sessionId) {
    // Twilio sends 'connected'/'start' (with the streamSid) within milliseconds,
    // long before the DB lookups below finish and the transport starts listening.
    // Buffer everything and replay once the realtime session is wired up, or the
    // transport never learns the streamSid and Twilio drops all outbound audio.
    const earlyFrames = []
    const bufferEarly = (data, isBinary) => { earlyFrames.push([data, isBinary]) }
    twilioWebSocket.on('message', bufferEarly)

    const callSession = await CallSession().findById(sessionId)
    const referral = callSession ? await Referral().findById(callSession.referralId) : null
    if (!callSession || !referral) {
        console.error('voiceStream: unknown session', sessionId)
        twilioWebSocket.close()
        return
    }

    const agent = new RealtimeAgent({
        name: 'TIN scheduling assistant',
        instructions: agentInstructions(referral),
        tools: buildTools(referral._id.toString(), callSession._id.toString()),
    })

    const transport = new TwilioRealtimeTransportLayer({ twilioWebSocket })
    const session = new RealtimeSession(agent, {
        transport,
        model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
        config: {
            audio: {
                output: { voice: process.env.OPENAI_REALTIME_VOICE || 'marin' },
                input: {
                    transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
                    // phone handset audio: filter line noise so it doesn't count as speech
                    noiseReduction: { type: 'near_field' },
                    // the SDK default (semantic_vad) waits several seconds whenever a
                    // sentence sounds unfinished ("uh...", "my date of birth is...").
                    // Plain silence-based VAD answers promptly; the higher threshold
                    // keeps background noise from cutting the agent off mid-sentence.
                    turnDetection: {
                        type: 'server_vad',
                        threshold: Number(process.env.CALL_VAD_THRESHOLD || 0.7),
                        prefixPaddingMs: 300,
                        silenceDurationMs: Number(process.env.CALL_VAD_SILENCE_MS || 700),
                        interruptResponse: true,
                    },
                },
            },
        },
    })

    // transcripts arrive asynchronously, so rebuild from the full history on
    // every update instead of pushing (history_added items are still empty)
    session.on('history_updated', (history) => {
        const lines = history.map(extractTranscript).filter(Boolean)
        if (!lines.length) return
        CallSession().updateOne(
            { _id: callSession._id },
            { $set: { transcript: lines.map(l => ({ role: l.role, text: l.text, at: new Date() })) } }
        ).catch(() => { })
    })
    session.on('error', (err) => {
        console.error('voiceStream: realtime error', err?.error || err)
    })

    // silence watchdog: VAD only reacts to speech, so a patient who answers and
    // says nothing would otherwise hold the line open until Twilio's timeLimit.
    // Nudge twice, then hang up and finalize.
    const nudgeAfterSec = Number(process.env.CALL_SILENCE_NUDGE_SEC || 20)
    const maxNudges = Number(process.env.CALL_SILENCE_MAX_NUDGES || 2)
    let lastAudioAt = Date.now()
    let nudges = 0
    session.on('transport_event', (event) => {
        const type = event?.type || ''
        if (type === 'input_audio_buffer.speech_started' || type.endsWith('audio.delta') || type === 'response.done') {
            lastAudioAt = Date.now()
            if (type === 'input_audio_buffer.speech_started') nudges = 0
        }
    })
    const silenceTimer = setInterval(() => {
        if (Date.now() - lastAudioAt < nudgeAfterSec * 1000) return
        lastAudioAt = Date.now()
        if (nudges < maxNudges) {
            nudges += 1
            session.transport.sendEvent({
                type: 'response.create',
                response: { instructions: 'The patient has been silent for a while. Briefly ask if they are still there. Do not repeat earlier questions.' },
            })
            return
        }
        clearInterval(silenceTimer)
        console.log(`voiceStream: silence timeout, hanging up session ${callSession._id}`)
        twilioService.endCall(callSession.twilioCallSid).catch(err =>
            console.error('voiceStream: silence hangup failed', err.message))
        finalizeCall(callSession._id, CALL_OUTCOMES.INCOMPLETE, { reason: 'silence timeout' })
            .catch(err => console.error('voiceStream: silence finalize failed', err.message))
    }, 5 * 1000)

    twilioWebSocket.on('close', async () => {
        clearInterval(silenceTimer)
        try {
            session.close()
        } catch (_err) { /* already closed */ }
        // the Twilio status webhook normally finalizes; this is the fallback
        setTimeout(() => {
            finalizeCall(callSession._id, CALL_OUTCOMES.INCOMPLETE, { reason: 'stream closed' })
                .catch(err => console.error('voiceStream: finalize fallback failed', err.message))
        }, 15 * 1000)
    })

    try {
        await session.connect({ apiKey: process.env.OPENAI_API_KEY })
        // hand the buffered Twilio frames (incl. 'start') to the transport, in order
        twilioWebSocket.off('message', bufferEarly)
        for (const [data, isBinary] of earlyFrames) twilioWebSocket.emit('message', data, isBinary)
        earlyFrames.length = 0
        // outbound call: the agent must greet first, VAD only reacts to the patient
        session.transport.sendEvent({ type: 'response.create' })
        console.log(`voiceStream: realtime session live for referral ${referral._id}`)
    } catch (err) {
        console.error('voiceStream: could not connect realtime session', err.message)
        twilioWebSocket.close()
    }
}

/**
 * Raw WebSocket endpoint for Twilio Media Streams at /ws/voice?sessionId=...
 * Hooks the HTTP server's upgrade event (workforce-api voiceStream pattern).
 */
function registerVoiceStream(server) {
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
        let url
        try {
            url = new URL(req.url, 'http://localhost')
        } catch (_err) {
            socket.destroy()
            return
        }
        const match = url.pathname.match(/^\/ws\/voice(?:\/([a-f0-9]{24}))?$/)
        if (!match) {
            socket.destroy() // only websocket endpoint on this server
            return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const sessionId = match[1] || url.searchParams.get('sessionId')
            handleConnection(ws, sessionId).catch(err => {
                console.error('voiceStream: connection handler failed', err)
                ws.close()
            })
        })
    })
    console.log('voiceStream: websocket endpoint ready at /ws/voice')
}

module.exports = { registerVoiceStream, buildTools, agentInstructions, bookingNote }
