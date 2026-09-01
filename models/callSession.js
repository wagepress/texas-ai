const mongoose = require('mongoose')
const mongoosePaginate = require('mongoose-paginate-v2')

/**
 * One document per outbound verification call attempt.
 * The Twilio webhooks and the realtime voice bridge both look sessions up by twilioCallSid.
 */
const callSessionSchema = new mongoose.Schema({
    referralId: { type: mongoose.Schema.Types.ObjectId, ref: 'referrals', required: true, index: true },
    twilioCallSid: { type: String, default: '', index: true },
    to: { type: String, default: '' },
    from: { type: String, default: '' },
    status: { type: String, default: 'initiated' },    // Twilio call status: initiated/ringing/in-progress/completed/busy/no-answer/failed/canceled
    answeredBy: { type: String, default: '' },         // AMD result: human / machine_start / machine_end_beep / ...
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSec: { type: Number, default: 0 },
    outcome: { type: String, default: '' },            // constants/referralStatus CALL_OUTCOMES
    outcomeDetail: { type: mongoose.Schema.Types.Mixed, default: {} }, // whatever save_call_outcome tool reported
    transcript: [{
        role: { type: String },                        // assistant / user
        text: { type: String },
        at: { type: Date },
    }],
    error: { type: String, default: '' },
}, { timestamps: true })

callSessionSchema.plugin(mongoosePaginate)

mongoose.model('callSessions', callSessionSchema)
