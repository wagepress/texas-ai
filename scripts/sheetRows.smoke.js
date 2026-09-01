/**
 * Offline smoke test for the referral -> TIN ALL row mapping.
 * Run: node scripts/sheetRows.smoke.js
 */
const assert = require('assert')
const { buildRowsForReferral, COL, categoryForStudy, refDocName, attyCell, dobPhoneCell } = require('../utils/sheetRows')

const referral = {
    createdAt: new Date('2026-08-28T15:00:00Z'),
    emailSubject: 'MRI Referral - Bilal Lalani',
    attachmentName: 'scan.pdf',
    facility: 'I-10',
    stat: false,
    attorney: 'Dhanani Law PLLC',
    patient: {
        firstName: 'Bilal', lastName: 'Lalani', dob: '8/11/1993',
        primaryPhone: '(832) 384-2384', secondaryPhone: '', alternatePhone: '832 955 2255',
    },
    doctor: { name: 'Dr. Ruben Munguia' },
    studies: [
        { description: 'MRI CERVICAL', cpt: '72141' },
        { description: 'MRI LUMBAR', cpt: '72148' },
    ],
}

const rows = buildRowsForReferral(referral)
assert.strictEqual(rows.length, 2, 'one row per study')
assert.ok(rows.every(row => row.length === 30), 'rows span A..AD')

const [first, second] = rows
assert.strictEqual(first[COL.FACILITY], 'I-10')
assert.strictEqual(first[COL.PATIENT], 'LALANI, BILAL')
assert.strictEqual(first[COL.STUDY], 'MRI CERVICAL')
assert.ok(first[COL.DOB_PHONE].includes('DOB 8/11/1993'), `dob cell: ${first[COL.DOB_PHONE]}`)
assert.ok(first[COL.DOB_PHONE].includes('#832-384-2384'), 'primary phone in dob cell')
assert.ok(first[COL.DOB_PHONE].includes('#832-955-2255'), 'alternate phone in dob cell')
assert.strictEqual(first[COL.REF_DOC], 'MUNGUIA, RUBEN')
assert.ok(/^\d{2}\/\d{2}\/\d{4}$/.test(first[COL.RECD_DATE]), 'recd date is MM/DD/YYYY')
assert.ok(first[COL.FILE_NUMBER].includes('MRI Referral'), 'file number from email subject')
assert.ok(/^PENDING-\d{2}\/\d{2}\/\d{2}-AI-CC\/\/$/.test(first[COL.CALL_LOG]), `initial K note: ${first[COL.CALL_LOG]}`)
assert.strictEqual(first[COL.ATTY], 'ATTY, DHANANI LAW PLLC')
assert.strictEqual(first[COL.CAT], 'MR')
assert.ok(/^\d{4}\.\d{2}$/.test(first[COL.MONTH]), 'month tag YYYY.MM')
assert.strictEqual(first[COL.UNITS], 1)
assert.strictEqual(first[COL.FC], 'LOP')

assert.strictEqual(second[COL.STUDY], 'MRI LUMBAR')
assert.strictEqual(second[COL.DOB_PHONE], '-', 'SA rows use "-" for dob')
assert.strictEqual(second[COL.FILE_NUMBER], 'SA')
assert.strictEqual(second[COL.CALL_LOG], 'SA')
assert.strictEqual(second[COL.ATTY], 'ATTY, DHANANI LAW PLLC')

// helpers
assert.strictEqual(categoryForStudy('CT BRAIN W/O'), 'CT')
assert.strictEqual(categoryForStudy('XRAY C SPINE'), 'XR')
assert.strictEqual(categoryForStudy('US ABD/PEL/TRANSVAG'), 'US')
assert.strictEqual(refDocName('Anthony Dargin'), 'DARGIN, ANTHONY')
assert.strictEqual(refDocName('Dr. Janice Brown, D.C.'), 'BROWN, JANICE')
assert.strictEqual(attyCell('ATTY, BADDERS LAW FIRM'), 'ATTY, BADDERS LAW FIRM')
assert.strictEqual(attyCell(''), '')
assert.strictEqual(dobPhoneCell({ patient: {} }), '-')

// stat flag shows in the pending note
const statRows = buildRowsForReferral({ ...referral, stat: true })
assert.ok(statRows[0][COL.CALL_LOG].startsWith('STAT PENDING'), 'stat referrals flagged in K')

// no studies at all still produces a reviewable row
const empty = buildRowsForReferral({ ...referral, studies: [] })
assert.strictEqual(empty.length, 1)
assert.strictEqual(empty[0][COL.STUDY], 'UNKNOWN STUDY')

console.log('sheetRows.smoke: all assertions passed')
