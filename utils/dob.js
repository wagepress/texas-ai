const moment = require('moment-timezone')

/**
 * Date-of-birth helpers for the voice agent. We always store and show DOBs in
 * US format (MM/DD/YYYY), but patients say them however they like, so the
 * comparison happens here instead of in the model.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function fixYear(year) {
    if (year >= 100) return year
    // two-digit year: a birth year can't be in the future
    const century = year + 2000 > moment().year() ? 1900 : 2000
    return century + year
}

function build(month, day, year) {
    if (!month || !day || year == null) return null
    const m = moment({ year: fixYear(year), month: month - 1, day })
    if (!m.isValid() || m.isAfter(moment())) return null
    return { month, day, year: m.year() }
}

/** Parse a spoken/typed DOB into { month, day, year, alt? }; alt is the day-first reading when ambiguous. */
function parseDob(input) {
    if (!input) return null
    const text = String(input).toLowerCase()
        .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
        .replace(/\bof\b|,/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

    // month name: "august 11 1993", "11 august 1993", "aug 11 93"
    const monthIdx = MONTHS.findIndex(name => new RegExp(`\\b${name.slice(0, 3)}[a-z]*\\.?\\b`).test(text))
    if (monthIdx >= 0) {
        const nums = (text.match(/\d+/g) || []).map(Number)
        if (nums.length < 2) return null
        let yearAt = nums.findIndex(n => n > 31)
        if (yearAt < 0) yearAt = nums.length - 1
        const day = nums.find((n, i) => i !== yearAt)
        return build(monthIdx + 1, day, nums[yearAt])
    }

    // ISO: 1993-08-11
    let match = text.match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})$/)
    if (match) return build(Number(match[2]), Number(match[3]), Number(match[1]))

    // numeric with separators: 8/11/1993, 08-11-93, 8.11.1993, 8 11 1993
    match = text.match(/^(\d{1,2})\D+(\d{1,2})\D+(\d{2}|\d{4})$/)
    // digits only: 08111993
    if (!match) match = text.match(/^(\d{2})(\d{2})(\d{4})$/)
    if (!match) return null
    const [a, b, year] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const us = build(a, b, year)       // US reading first
    const dayFirst = build(b, a, year) // then day-first
    if (!us) return dayFirst
    if (dayFirst && a !== b) us.alt = dayFirst
    return us
}

const same = (x, y) => x && y && x.month === y.month && x.day === y.day && x.year === y.year

/** Normalize any DOB to MM/DD/YYYY; returns the input unchanged if it can't be parsed. */
function formatDob(input) {
    const d = parseDob(input)
    if (!d) return input ? String(input) : ''
    return moment({ year: d.year, month: d.month - 1, day: d.day }).format('MM/DD/YYYY')
}

/** "August 11, 1993" - how the agent should say a DOB out loud. */
function spokenDob(input) {
    const d = parseDob(input)
    if (!d) return input ? String(input) : ''
    return moment({ year: d.year, month: d.month - 1, day: d.day }).format('MMMM D, YYYY')
}

/**
 * Compare what the patient said with the DOB on file.
 * Returns { result: 'match' | 'mismatch' | 'unclear' | 'no_dob_on_file', heard? }
 */
function compareDob(stated, onFile) {
    const file = parseDob(onFile)
    if (!file) return { result: 'no_dob_on_file' }
    const said = parseDob(stated)
    if (!said) return { result: 'unclear' }
    if (same(said, file) || same(said.alt, file)) return { result: 'match', heard: formatDob(onFile) }
    return { result: 'mismatch', heard: moment({ year: said.year, month: said.month - 1, day: said.day }).format('MM/DD/YYYY') }
}

module.exports = { parseDob, formatDob, spokenDob, compareDob }
