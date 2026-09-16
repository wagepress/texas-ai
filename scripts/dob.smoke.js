/**
 * Offline smoke test for date-of-birth parsing/matching used by the voice agent.
 * Run: node scripts/dob.smoke.js
 */
const assert = require('assert')
const { formatDob, spokenDob, compareDob } = require('../utils/dob')

const onFile = '08/11/1993'
const matches = [
    '08/11/1993', '8/11/1993', '8/11/93', '08-11-1993', '8.11.1993', '8 11 1993', '08111993',
    '1993-08-11', 'August 11, 1993', 'august 11th 1993', 'Aug 11 93', 'the 11th of August 1993',
    '11 August 1993', '11/08/1993', '11/8/93',
]
for (const said of matches) {
    assert.strictEqual(compareDob(said, onFile).result, 'match', `should match: ${said}`)
}
assert.strictEqual(compareDob('8/11/1993', '1993-08-11').result, 'match', 'ISO on file still matches')

assert.strictEqual(compareDob('08/12/1993', onFile).result, 'mismatch', 'different day')
assert.strictEqual(compareDob('08/12/1993', onFile).heard, '08/12/1993')
assert.strictEqual(compareDob('August 11 1994', onFile).result, 'mismatch', 'different year')
assert.strictEqual(compareDob('I think the summer', onFile).result, 'unclear')
assert.strictEqual(compareDob('13/13/1993', onFile).result, 'unclear', 'impossible date')
assert.strictEqual(compareDob('8/11/1993', '').result, 'no_dob_on_file')

assert.strictEqual(formatDob('8/1/93'), '08/01/1993', 'normalizes to MM/DD/YYYY')
assert.strictEqual(formatDob('3/4/05'), '03/04/2005', 'two-digit recent year')
assert.strictEqual(formatDob('March 4th, 1980'), '03/04/1980')
assert.strictEqual(formatDob('garbage'), 'garbage', 'unparseable left as-is')
assert.strictEqual(spokenDob('08/11/1993'), 'August 11, 1993')

console.log('dob smoke: ok')
