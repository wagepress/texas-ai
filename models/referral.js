const mongoose = require('mongoose')
const mongoosePaginate = require('mongoose-paginate-v2')
const { REFERRAL_STATUS } = require('../constants/referralStatus')

/**
 * One referral = one patient slip (a slip can order several studies).
 * A single email attachment may contain many slips - each becomes its own referral.
 */
const studySchema = new mongoose.Schema({
    description: { type: String, required: true },     // e.g. "MRI CERVICAL", "XRAY RT WRIST"
    cpt: { type: String, default: '' },
    laterality: { type: String, default: '' },         // RT / LT / BILATERAL / ''
    contrast: { type: String, default: '' },           // "W/O", "W + W/O", ''
    sheetRow: { type: Number, default: null },         // 1-based row number on the Google Sheet
}, { _id: false })

const referralSchema = new mongoose.Schema({
    // where the slip came from
    emailMessageId: { type: String, default: '' },
    emailSubject: { type: String, default: '' },
    emailFrom: { type: String, default: '' },
    attachmentPath: { type: String, default: '' },
    attachmentName: { type: String, default: '' },
    attachmentMime: { type: String, default: '' },
    slipIndex: { type: Number, default: 0 },           // index of the slip inside the attachment

    status: { type: String, enum: Object.values(REFERRAL_STATUS), default: REFERRAL_STATUS.RECEIVED, index: true },
    lastError: { type: String, default: '' },
    extractionAttempts: { type: Number, default: 0 },
    // work-claim leases so overlapping processes (e.g. during a deploy) never
    // pick up the same referral twice
    extractClaimedAt: { type: Date, default: null },
    logClaimedAt: { type: Date, default: null },

    // extracted slip data
    patient: {
        firstName: { type: String, default: '' },
        lastName: { type: String, default: '' },
        dob: { type: String, default: '' },            // MM/DD/YYYY
        ssn: { type: String, default: '' },
        primaryPhone: { type: String, default: '' },
        secondaryPhone: { type: String, default: '' },
        alternatePhone: { type: String, default: '' },
        insuredName: { type: String, default: '' },
        insuranceName: { type: String, default: '' },
        planName: { type: String, default: '' },
        memberId: { type: String, default: '' },
        groupNumber: { type: String, default: '' },
    },
    attorney: { type: String, default: '' },           // workers comp carrier / law firm
    doctor: {
        name: { type: String, default: '' },
        phone: { type: String, default: '' },
        fax: { type: String, default: '' },
        email: { type: String, default: '' },
        npi: { type: String, default: '' },
    },
    facility: { type: String, default: '' },           // imaging center marked on the slip
    clinicalFindings: { type: String, default: '' },
    stat: { type: Boolean, default: false },
    claustrophobic: { type: String, default: '' },     // YES / NO / ''
    sedation: { type: String, default: '' },
    slipDate: { type: String, default: '' },
    comments: { type: String, default: '' },
    specialInstructions: { type: String, default: '' },
    studies: [studySchema],
    extractionConfidence: { type: String, default: '' }, // high / medium / low
    extractionNotes: { type: String, default: '' },

    // google sheet bookkeeping
    sheet: {
        spreadsheetId: { type: String, default: '' },
        tab: { type: String, default: '' },
        rows: [{ type: Number }],                      // 1-based row numbers, one per study
    },

    // verification call state
    call: {
        attempts: { type: Number, default: 0 },
        nextCallAt: { type: Date, default: null },
        lastCallAt: { type: Date, default: null },
        lastOutcome: { type: String, default: '' },
        verified: { type: Boolean, default: false },
        appointmentDate: { type: String, default: '' },  // MM/DD/YYYY
        appointmentTime: { type: String, default: '' },  // e.g. "10:00AM"
        screening: { type: mongoose.Schema.Types.Mixed, default: {} },
        correctedInfo: { type: mongoose.Schema.Types.Mixed, default: {} },
        notes: [{ type: String }],                       // running call log, sheet K-column style
    },
}, { timestamps: true })

referralSchema.plugin(mongoosePaginate)
referralSchema.index({ status: 1, 'call.nextCallAt': 1 })

mongoose.model('referrals', referralSchema)
