const { ValidationError } = require('yup')
const moment = require('moment-timezone')

const TIMEZONE = process.env.TIMEZONE || 'America/Chicago'

function handleError(res, err) {
    if (err instanceof ValidationError) return res.status(400).send({ status: false, message: err.message })
    const code = Number(err?.status || err?.statusCode)
    if (code >= 400 && code < 600) return res.status(code).send({ status: false, message: err.message })
    if (err && err.code === 11000) return res.status(409).send({ status: false, message: 'A record with that value already exists.' })
    console.error('controller error:', err)
    res.status(500).send({ status: false, message: 'Something went wrong. Please try again.' })
}

function escapeRegex(str = '') {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns '' when the
 * value does not contain a dialable 10-digit number.
 */
function normalizePhone(raw = '') {
    const digits = String(raw).replace(/\D/g, '')
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    if (String(raw).trim().startsWith('+') && digits.length > 10) return `+${digits}`
    return ''
}

/** Pretty US format for speech/sheet: (832) 384-2384 -> 832-384-2384 */
function displayPhone(raw = '') {
    const e164 = normalizePhone(raw)
    if (!e164) return String(raw || '').trim()
    const d = e164.slice(-10)
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
}

function nowTz() {
    return moment.tz(TIMEZONE)
}

/** MM/DD/YYYY in the clinic timezone */
function formatDateMDY(date = null) {
    return (date ? moment.tz(date, TIMEZONE) : nowTz()).format('MM/DD/YYYY')
}

/** MM/DD/YY in the clinic timezone - used inside K-column call notes */
function formatDateMDYShort(date = null) {
    return (date ? moment.tz(date, TIMEZONE) : nowTz()).format('MM/DD/YY')
}

/** "2026.08" style month tag used in the sheet's MONTH column */
function monthTag(date = null) {
    return (date ? moment.tz(date, TIMEZONE) : nowTz()).format('YYYY.MM')
}

/**
 * Format a call-log entry the way the front desk writes them in column K:
 *   "LVM, SENT NC-08/28/26-AI-CC//"
 */
function noteStamp(text) {
    return `${String(text).trim()}-${formatDateMDYShort()}-AI-CC//`
}

/** "LALANI, BILAL" - sheet stores patient names LAST, FIRST in caps */
function sheetName(firstName = '', lastName = '') {
    const last = String(lastName).trim().toUpperCase()
    const first = String(firstName).trim().toUpperCase()
    if (!last && !first) return ''
    if (!last) return first
    if (!first) return last
    return `${last}, ${first}`
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
    TIMEZONE,
    handleError,
    escapeRegex,
    normalizePhone,
    displayPhone,
    nowTz,
    formatDateMDY,
    formatDateMDYShort,
    monthTag,
    noteStamp,
    sheetName,
    sleep,
}
