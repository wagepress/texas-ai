/**
 * Referral lifecycle:
 *  received      -> attachment saved from email, waiting for extraction
 *  extracted     -> AI extraction finished, waiting to be logged on the sheet
 *  logged        -> rows appended to the Google Sheet, waiting for the verification call
 *  calling       -> an outbound verification call is currently in progress
 *  scheduled     -> patient verified + appointment booked, sheet updated
 *  unreachable   -> max call attempts exhausted without reaching the patient
 *  needs_review  -> extraction could not confidently read the slip, a human must look at it
 *  failed        -> unrecoverable processing error (details in lastError)
 */
const REFERRAL_STATUS = {
    RECEIVED: 'received',
    EXTRACTED: 'extracted',
    LOGGED: 'logged',
    CALLING: 'calling',
    SCHEDULED: 'scheduled',
    UNREACHABLE: 'unreachable',
    NEEDS_REVIEW: 'needs_review',
    FAILED: 'failed',
}

const CALL_OUTCOMES = {
    SCHEDULED: 'scheduled',
    NO_ANSWER: 'no_answer',
    VOICEMAIL: 'voicemail',
    BUSY: 'busy',
    FAILED: 'failed',
    DECLINED: 'declined',
    CALLBACK_REQUESTED: 'callback_requested',
    INCOMPLETE: 'incomplete',
}

module.exports = { REFERRAL_STATUS, CALL_OUTCOMES }
