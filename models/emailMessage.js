const mongoose = require('mongoose')
const mongoosePaginate = require('mongoose-paginate-v2')

/**
 * Processed-mail ledger so the IMAP poller never handles the same message twice,
 * even if the \Seen flag gets reset or the mailbox is shared.
 */
const emailMessageSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true },
    uid: { type: Number, default: null },
    subject: { type: String, default: '' },
    from: { type: String, default: '' },
    receivedAt: { type: Date, default: null },
    attachments: [{
        filename: { type: String },
        path: { type: String },
        mime: { type: String },
        size: { type: Number },
    }],
    referralIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'referrals' }],
    status: { type: String, default: 'processed' },    // processed / no_attachments / error
    error: { type: String, default: '' },
}, { timestamps: true })

emailMessageSchema.plugin(mongoosePaginate)

mongoose.model('emailMessages', emailMessageSchema)
