const mongoose = require('mongoose')
const { escapeRegex, handleError } = require('../utils/helpers')
const { REFERRAL_STATUS } = require('../constants/referralStatus')
const { pollOnce } = require('../utils/emailPoller')
const { initiateCall } = require('../utils/callScheduler')

const Referral = () => mongoose.model('referrals')
const CallSession = () => mongoose.model('callSessions')

module.exports = {
    list: async function (req, res) {
        const { limit = 10, page = 1, search = '', status = '' } = req.body
        try {
            const query = {}
            if (status) query.status = status
            if (search) {
                const rx = { $regex: escapeRegex(search), $options: 'i' }
                query.$or = [
                    { 'patient.firstName': rx }, { 'patient.lastName': rx },
                    { attorney: rx }, { 'doctor.name': rx }, { emailSubject: rx },
                    { 'studies.description': rx },
                ]
            }
            const result = await Referral().paginate(query, { limit, page, sort: { createdAt: -1 } })
            res.status(200).send({ status: true, message: 'Referrals fetched successfully', data: result })
        } catch (err) { handleError(res, err) }
    },

    detail: async function (req, res) {
        try {
            const referral = await Referral().findById(req.params.id)
            if (!referral) return res.status(404).send({ status: false, message: 'Referral not found' })
            const calls = await CallSession().find({ referralId: referral._id }).sort({ createdAt: -1 })
            res.status(200).send({ status: true, message: 'Referral fetched successfully', data: { referral, calls } })
        } catch (err) { handleError(res, err) }
    },

    stats: async function (req, res) {
        try {
            const byStatus = await Referral().aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
            const data = Object.fromEntries(byStatus.map(row => [row._id, row.count]))
            res.status(200).send({ status: true, message: 'Stats fetched successfully', data })
        } catch (err) { handleError(res, err) }
    },

    /** Re-run extraction on a slip (e.g. after it landed in needs_review). */
    retryExtraction: async function (req, res) {
        try {
            const referral = await Referral().findById(req.params.id)
            if (!referral) return res.status(404).send({ status: false, message: 'Referral not found' })
            referral.status = REFERRAL_STATUS.RECEIVED
            referral.extractionAttempts = 0
            referral.lastError = ''
            await referral.save()
            res.status(200).send({ status: true, message: 'Referral queued for re-extraction', data: referral })
        } catch (err) { handleError(res, err) }
    },

    /** Force an immediate verification call, ignoring the retry backoff. */
    callNow: async function (req, res) {
        try {
            const referral = await Referral().findById(req.params.id)
            if (!referral) return res.status(404).send({ status: false, message: 'Referral not found' })
            if (![REFERRAL_STATUS.LOGGED, REFERRAL_STATUS.UNREACHABLE, REFERRAL_STATUS.NEEDS_REVIEW].includes(referral.status)) {
                return res.status(400).send({ status: false, message: `Cannot call a referral in status "${referral.status}"` })
            }
            referral.status = REFERRAL_STATUS.LOGGED
            const session = await initiateCall(referral)
            if (!session) return res.status(502).send({ status: false, message: referral.lastError || 'Call could not be started' })
            res.status(200).send({ status: true, message: 'Call started', data: session })
        } catch (err) { handleError(res, err) }
    },

    /** Trigger an immediate mailbox poll instead of waiting for the interval. */
    pollEmail: async function (req, res) {
        try {
            const result = await pollOnce()
            res.status(200).send({ status: true, message: 'Mailbox polled', data: result })
        } catch (err) { handleError(res, err) }
    },

    callList: async function (req, res) {
        const { limit = 10, page = 1 } = req.body
        try {
            const result = await CallSession().paginate({}, { limit, page, sort: { createdAt: -1 }, populate: 'referralId' })
            res.status(200).send({ status: true, message: 'Calls fetched successfully', data: result })
        } catch (err) { handleError(res, err) }
    },
}
