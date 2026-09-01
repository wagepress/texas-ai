/**
 * Offline smoke test for slot suggestion/validation and the calling window.
 * Run: node scripts/slots.smoke.js
 */
const assert = require('assert')
const moment = require('moment-timezone')
const { suggestSlots, validateSlot, withinCallHours, nextCallWindow } = require('../utils/slots')
const { TIMEZONE } = require('../utils/helpers')

const slots = suggestSlots(6)
assert.strictEqual(slots.length, 6, 'suggests the requested number of slots')
for (const slot of slots) {
    assert.ok(/^\d{2}\/\d{2}\/\d{4}$/.test(slot.date), `slot date format: ${slot.date}`)
    assert.ok(/^\d{1,2}:\d{2}(AM|PM)$/.test(slot.time), `slot time format: ${slot.time}`)
    const check = validateSlot(slot.date, slot.time)
    assert.ok(check.valid, `suggested slot must validate: ${slot.date} ${slot.time} -> ${check.reason}`)
    const day = moment.tz(slot.date, 'MM/DD/YYYY', TIMEZONE).day()
    assert.ok(day !== 0, 'never suggests Sunday')
}

// invalid inputs
assert.ok(!validateSlot('never', '10AM').valid, 'garbage date rejected')
assert.ok(!validateSlot('01/01/2020', '10:00AM').valid, 'past date rejected')
const tooLate = suggestSlots(1)[0]
assert.ok(!validateSlot(tooLate.date, '11:30PM').valid, 'after-hours time rejected')

// sunday rejected
const nextSunday = moment.tz(TIMEZONE).add(1, 'day')
while (nextSunday.day() !== 0) nextSunday.add(1, 'day')
if (nextSunday.diff(moment.tz(TIMEZONE), 'days') < 13) {
    assert.ok(!validateSlot(nextSunday.format('MM/DD/YYYY'), '10:00AM').valid, 'Sunday rejected')
}

// spoken form parses to something sane
assert.ok(slots[0].spoken.includes(' at '), 'spoken form present')

// call window helpers
const businessMoment = moment.tz(TIMEZONE).day(3).hour(10).minute(0) // a Wednesday 10:00
assert.ok(withinCallHours(businessMoment), 'wednesday 10am is inside the calling window')
const midnight = moment.tz(TIMEZONE).day(3).hour(23)
assert.ok(!withinCallHours(midnight), '11pm is outside the calling window')
const resumed = moment.tz(nextCallWindow(midnight.toDate()), TIMEZONE)
assert.ok(withinCallHours(resumed), `nextCallWindow lands inside the window (got ${resumed.format()})`)
assert.ok(resumed.isAfter(midnight), 'nextCallWindow moves forward')

console.log('slots.smoke: all assertions passed')
