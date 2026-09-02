const mongoose = require('mongoose')
const openaiClient = require('../services/openaiClient')
const googleSheets = require('../services/googleSheets')
const { buildRowsForReferral } = require('./sheetRows')
const { normalizePhone, noteStamp } = require('./helpers')
const { REFERRAL_STATUS } = require('../constants/referralStatus')

const Referral = () => mongoose.model('referrals')

const MAX_EXTRACTION_ATTEMPTS = 3
// how long a work claim holds before another process may retry the referral
const CLAIM_LEASE_MS = 5 * 60 * 1000

function s(value) {
    return value == null ? '' : String(value).trim()
}

/** Copy one extracted slip onto a referral document (mutates, does not save). */
function applySlip(referral, slip) {
    referral.patient = {
        firstName: s(slip.patient?.firstName),
        lastName: s(slip.patient?.lastName),
        dob: s(slip.patient?.dob),
        ssn: s(slip.patient?.ssn),
        primaryPhone: s(slip.patient?.primaryPhone),
        secondaryPhone: s(slip.patient?.secondaryPhone),
        alternatePhone: s(slip.patient?.alternatePhone),
        insuredName: s(slip.patient?.insuredName),
        insuranceName: s(slip.patient?.insuranceName),
        planName: s(slip.patient?.planName),
        memberId: s(slip.patient?.memberId),
        groupNumber: s(slip.patient?.groupNumber),
    }
    referral.attorney = s(slip.attorney)
    referral.doctor = {
        name: s(slip.doctor?.name),
        phone: s(slip.doctor?.phone),
        fax: s(slip.doctor?.fax),
        email: s(slip.doctor?.email),
        npi: s(slip.doctor?.npi),
    }
    referral.facility = s(slip.facility)
    referral.clinicalFindings = s(slip.clinicalFindings)
    referral.stat = !!slip.stat
    referral.claustrophobic = s(slip.claustrophobic)
    referral.sedation = s(slip.sedation)
    referral.slipDate = s(slip.slipDate)
    referral.comments = s(slip.comments)
    referral.specialInstructions = s(slip.specialInstructions)
    referral.studies = (slip.studies || []).map(study => ({
        description: s(study.description).toUpperCase(),
        cpt: s(study.cpt),
        laterality: s(study.laterality),
        contrast: s(study.contrast),
    }))
    referral.extractionConfidence = s(slip.confidence)
    referral.extractionNotes = s(slip.notes)
}

function bestPhone(referral) {
    return normalizePhone(referral.patient?.primaryPhone) ||
        normalizePhone(referral.patient?.secondaryPhone) ||
        normalizePhone(referral.patient?.alternatePhone)
}

/** A same-patient same-study referral arriving within the window is a re-send of
 * the same slip. Older matches are a genuine new order (patients repeat studies). */
async function findDuplicate(referral) {
    if (!referral.patient?.lastName || !referral.patient?.dob) return null
    const windowDays = Number(process.env.DUPLICATE_WINDOW_DAYS || 30)
    return Referral().findOne({
        _id: { $ne: referral._id },
        createdAt: { $gte: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000) },
        'patient.lastName': new RegExp(`^${referral.patient.lastName}$`, 'i'),
        'patient.dob': referral.patient.dob,
        'studies.description': { $in: referral.studies.map(st => st.description) },
        status: { $nin: [REFERRAL_STATUS.FAILED, REFERRAL_STATUS.NEEDS_REVIEW] },
    })
}

function slipStatus(slip) {
    if (!slip.studies?.length || slip.confidence === 'low') return REFERRAL_STATUS.NEEDS_REVIEW
    return REFERRAL_STATUS.EXTRACTED
}

/** Phase A: run the OpenAI extraction agent over freshly received attachments. */
async function extractPending() {
    if (!process.env.OPENAI_API_KEY) return
    // atomic claim: overlapping processes (deploy switchover) must not both take it
    const claimExpired = new Date(Date.now() - CLAIM_LEASE_MS)
    const referral = await Referral().findOneAndUpdate(
        {
            status: REFERRAL_STATUS.RECEIVED,
            extractionAttempts: { $lt: MAX_EXTRACTION_ATTEMPTS },
            $or: [{ extractClaimedAt: null }, { extractClaimedAt: { $lt: claimExpired } }],
        },
        { $inc: { extractionAttempts: 1 }, $set: { extractClaimedAt: new Date() } },
        { sort: { createdAt: 1 }, new: true }
    )
    if (!referral) return

    try {
        const { slips = [] } = await openaiClient.extractSlipsFromFile(referral.attachmentPath, referral.attachmentMime) || {}
        if (!slips.length) {
            referral.status = REFERRAL_STATUS.NEEDS_REVIEW
            referral.extractionNotes = 'Extractor found no referral slip in this attachment'
            await referral.save()
            return
        }

        // first slip stays on this document, extra slips become sibling referrals
        applySlip(referral, slips[0])
        referral.status = slipStatus(slips[0])
        referral.lastError = ''
        await referral.save()

        for (let i = 1; i < slips.length; i++) {
            const sibling = new (Referral())({
                emailMessageId: referral.emailMessageId,
                emailSubject: referral.emailSubject,
                emailFrom: referral.emailFrom,
                attachmentPath: referral.attachmentPath,
                attachmentName: referral.attachmentName,
                attachmentMime: referral.attachmentMime,
                slipIndex: i,
                extractionAttempts: referral.extractionAttempts,
            })
            applySlip(sibling, slips[i])
            sibling.status = slipStatus(slips[i])
            await sibling.save()
        }
        console.log(`extractionEngine: extracted ${slips.length} slip(s) from ${referral.attachmentName}`)
    } catch (err) {
        console.error('extractionEngine: extraction failed for', referral._id.toString(), err.message)
        referral.lastError = err.message
        if (referral.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS) referral.status = REFERRAL_STATUS.FAILED
        await referral.save()
    }
}

/** Phase B: append extracted referrals to the Google Sheet log. */
async function logPending() {
    if (!googleSheets.isConfigured()) return
    // atomic claim, same reasoning as extractPending
    const claimExpired = new Date(Date.now() - CLAIM_LEASE_MS)
    const referral = await Referral().findOneAndUpdate(
        {
            status: REFERRAL_STATUS.EXTRACTED,
            $or: [{ logClaimedAt: null }, { logClaimedAt: { $lt: claimExpired } }],
        },
        { $set: { logClaimedAt: new Date() } },
        { sort: { createdAt: 1 }, new: true }
    )
    if (!referral) return

    try {
        const duplicate = await findDuplicate(referral)
        if (duplicate) {
            referral.status = REFERRAL_STATUS.NEEDS_REVIEW
            referral.extractionNotes = `Possible duplicate of referral ${duplicate._id} (same patient + study), not logged to sheet`
            await referral.save()
            console.log(`extractionEngine: referral ${referral._id} looks like a re-send of ${duplicate._id}, held for review`)
            return
        }

        const rows = buildRowsForReferral(referral)
        const firstRow = await googleSheets.appendRows(rows)
        referral.sheet = {
            spreadsheetId: googleSheets.spreadsheetId(),
            tab: googleSheets.tabName(),
            rows: rows.map((_row, i) => firstRow + i),
        }
        referral.studies.forEach((study, i) => { study.sheetRow = firstRow + i })

        if (bestPhone(referral)) {
            referral.status = REFERRAL_STATUS.LOGGED
            referral.call.nextCallAt = new Date()
        } else {
            referral.status = REFERRAL_STATUS.NEEDS_REVIEW
            referral.extractionNotes = [referral.extractionNotes, 'No dialable phone number on the slip'].filter(Boolean).join(' | ')
            await googleSheets.appendToCell(firstRow, 'K', noteStamp('NO VALID PHONE, NEEDS REVIEW')).catch(() => { })
        }
        await referral.save()
        console.log(`extractionEngine: logged referral ${referral._id} to sheet rows ${referral.sheet.rows.join(',')}`)
    } catch (err) {
        console.error('extractionEngine: sheet logging failed for', referral._id.toString(), err.message)
        referral.lastError = err.message
        await referral.save()
    }
}

let running = false

function startExtractionEngine() {
    const intervalMs = Number(process.env.EXTRACTION_INTERVAL_MS || 20 * 1000)
    const tick = async () => {
        if (running) return
        running = true
        try {
            await extractPending()
            await logPending()
        } catch (err) {
            console.error('extractionEngine error:', err.message)
        } finally {
            running = false
        }
    }
    setInterval(tick, intervalMs)
    console.log(`extractionEngine: running every ${intervalMs / 1000}s`)
}

module.exports = { startExtractionEngine, extractPending, logPending, applySlip, bestPhone }
