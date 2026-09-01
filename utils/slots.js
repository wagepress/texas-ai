const moment = require('moment-timezone')
const { TIMEZONE, nowTz } = require('./helpers')

/**
 * Appointment slot logic. Facilities take walk-in style bookings on the hour
 * during business hours; the voice agent offers slots from here and validates
 * whatever the patient asks for. Configure via env:
 *   BOOKING_HOURS_START / BOOKING_HOURS_END   (24h, default 8-18)
 *   BOOKING_DAYS_AHEAD                        (default 14, starting tomorrow)
 *   BOOKING_INCLUDE_SATURDAY                  (default false)
 *   CALL_HOURS_START / CALL_HOURS_END         outbound-call window (default 9-19)
 */

function bookingHours() {
    return {
        start: Number(process.env.BOOKING_HOURS_START || 8),
        end: Number(process.env.BOOKING_HOURS_END || 18),
    }
}

function isBookableDay(m) {
    const day = m.day() // 0 Sun .. 6 Sat
    if (day === 0) return false
    if (day === 6) return process.env.BOOKING_INCLUDE_SATURDAY === 'true'
    return true
}

function spoken(m) {
    return m.format('dddd, MMMM D [at] h:mm A')
}

/** Next `count` offerable slots, starting tomorrow. */
function suggestSlots(count = 6) {
    const { start, end } = bookingHours()
    const daysAhead = Number(process.env.BOOKING_DAYS_AHEAD || 14)
    const slots = []
    const cursor = nowTz().add(1, 'day').startOf('day')
    for (let d = 0; d < daysAhead && slots.length < count; d++) {
        const day = cursor.clone().add(d, 'days')
        if (!isBookableDay(day)) continue
        for (const hour of [start, Math.floor((start + end) / 2), end - 1]) {
            if (slots.length >= count) break
            const slot = day.clone().hour(hour).minute(0)
            slots.push({ date: slot.format('MM/DD/YYYY'), time: slot.format('h:mmA'), spoken: spoken(slot) })
        }
    }
    return slots
}

/**
 * Validate a patient-requested slot. Returns { valid, reason?, date?, time?, spoken? }
 * date: MM/DD/YYYY (also accepts YYYY-MM-DD), time: "10:00AM" / "10:00 AM" / "10AM".
 */
function validateSlot(dateStr, timeStr) {
    const { start, end } = bookingHours()
    const parsed = moment.tz(
        `${String(dateStr).trim()} ${String(timeStr).trim().toUpperCase().replace(/\s+/g, '')}`,
        ['MM/DD/YYYY h:mmA', 'MM/DD/YYYY hA', 'YYYY-MM-DD h:mmA', 'YYYY-MM-DD hA', 'M/D/YYYY h:mmA', 'M/D/YYYY hA'],
        true, TIMEZONE)
    if (!parsed.isValid()) return { valid: false, reason: 'Could not understand that date and time.' }
    if (parsed.isBefore(nowTz().add(2, 'hours'))) return { valid: false, reason: 'That time has already passed or is too soon. Offer a later slot.' }
    if (parsed.isAfter(nowTz().add(Number(process.env.BOOKING_DAYS_AHEAD || 14) + 1, 'days'))) return { valid: false, reason: 'That is too far out. Offer something within the next two weeks.' }
    if (!isBookableDay(parsed)) return { valid: false, reason: 'The facility is closed that day. Offer a weekday instead.' }
    const hourFloat = parsed.hour() + parsed.minute() / 60
    if (hourFloat < start || hourFloat > end - 0.5) return { valid: false, reason: `The facility books between ${start}:00 and ${end}:00. Offer a time inside that window.` }
    return { valid: true, date: parsed.format('MM/DD/YYYY'), time: parsed.format('h:mmA'), spoken: spoken(parsed) }
}

/** Whether we may place outbound calls to patients right now. */
function withinCallHours(m = null) {
    const at = m || nowTz()
    const startHour = Number(process.env.CALL_HOURS_START || 9)
    const endHour = Number(process.env.CALL_HOURS_END || 19)
    if (at.day() === 0) return false
    return at.hour() >= startHour && at.hour() < endHour
}

/** Push a date forward until it lands inside the calling window. */
function nextCallWindow(from = null) {
    const startHour = Number(process.env.CALL_HOURS_START || 9)
    let at = (from ? moment.tz(from, TIMEZONE) : nowTz()).clone()
    for (let guard = 0; guard < 14 && !withinCallHours(at); guard++) {
        if (at.hour() >= Number(process.env.CALL_HOURS_END || 19) || at.day() === 0) {
            at = at.add(1, 'day').hour(startHour).minute(0).second(0)
        } else {
            at = at.hour(startHour).minute(0).second(0)
        }
    }
    return at.toDate()
}

module.exports = { suggestSlots, validateSlot, withinCallHours, nextCallWindow }
