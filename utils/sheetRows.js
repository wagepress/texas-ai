const { formatDateMDY, monthTag, noteStamp, sheetName, displayPhone } = require('./helpers')

/**
 * Builds rows for the "TIN ALL" log sheet. Column layout (A..AD) copied from
 * the clinic's existing workbook:
 *   A FACILITY | B CHART | C PATIENT NAME | D STUDY | E "DOB mm/dd/yyyy #phone"
 *   F REF DOC (LAST, FIRST) | G RECD DATE | H FILE NUMBER | I APPT DATE | J APPT TIME
 *   K call log | L MGR COMMENTS | M REPORT SENT | N CLEAR LOP | O AUTH EXP DATE
 *   P AUTH STS | Q INTAKE | R BILLER | S atty | T VOB COMMENTS | U AMOUNT TO COLLECT
 *   V NO CHARGE | W INDG? | X/Y FS COMMENTS | Z CAT | AA MONTH | AB MGR SIGN OFF
 *   AC UNITS | AD FC
 * One row per ordered study; rows after the first use the clinic's "SA"
 * (same-as-above) convention and "-" in the DOB column.
 */

const COLUMNS = 30 // A..AD

const COL = {
    FACILITY: 0, CHART: 1, PATIENT: 2, STUDY: 3, DOB_PHONE: 4, REF_DOC: 5,
    RECD_DATE: 6, FILE_NUMBER: 7, APPT_DATE: 8, APPT_TIME: 9, CALL_LOG: 10,
    MGR_COMMENTS: 11, REPORT_SENT: 12, CLEAR_LOP: 13, AUTH_EXP: 14, AUTH_STS: 15,
    INTAKE: 16, BILLER: 17, ATTY: 18, VOB_COMMENTS: 19, AMOUNT: 20, NO_CHARGE: 21,
    INDG: 22, FS_COMMENTS_1: 23, FS_COMMENTS_2: 24, CAT: 25, MONTH: 26,
    SIGN_OFF: 27, UNITS: 28, FC: 29,
}

const HEADER = [
    'FACILITY', 'CHART', 'PATIENT NAME', 'STUDY', 'DOB 00/00/0000 #000-000-0000',
    'REF DOC NAME FIRST LAST NPI', 'RECD DATE', 'FILE NUMBER', 'APPT DATE', 'APPT TIME',
    'CALL LOG', 'MGR COMMENTS', 'REPORT SENT', 'CLEAR LOP', 'AUTH EXP DATE', 'AUTH STS',
    'INTAKE', 'BILLER', 'CLEAR LOP', 'VOB COMMENTS', 'AMOUNT TO COLLECT', 'NO CHARGE',
    'INDG?', 'FS COMMENTS', 'FS COMMENTS', 'CAT', 'MONTH', 'VNS MGR SIGN OFF', 'UNITS', 'FC',
]

/** "MRI CERVICAL" -> "MR", "CT BRAIN W/O" -> "CT", "XRAY C SPINE" -> "XR" */
function categoryForStudy(description = '') {
    const first = String(description).trim().toUpperCase().split(/\s+/)[0]
    if (first.startsWith('MRI') || first.startsWith('MRA')) return 'MR'
    if (first.startsWith('CT')) return 'CT'
    if (first.startsWith('XRAY') || first.startsWith('X-RAY')) return 'XR'
    if (first.startsWith('US') || first.startsWith('ULTRASOUND')) return 'US'
    return first.slice(0, 2) || ''
}

/** "Dr. Ruben Munguia" / "Anthony Dargin" -> "MUNGUIA, RUBEN" / "DARGIN, ANTHONY" */
function refDocName(name = '') {
    const cleaned = String(name)
        .replace(/\b[a-z](?:\.[a-z])+\.?(?=\s|,|$)/gi, '')   // dotted credentials: "D.C.", "M.D"
        .replace(/\b(dr|md|do|dc|dnp|fnp|pa|np|phd)\.?(?=\s|,|$)/gi, '')
        .replace(/[.,]/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
    if (!cleaned) return ''
    const parts = cleaned.split(' ')
    if (parts.length === 1) return parts[0].toUpperCase()
    const last = parts[parts.length - 1].toUpperCase()
    const first = parts.slice(0, -1).join(' ').toUpperCase()
    return `${last}, ${first}`
}

function dobPhoneCell(referral) {
    const pieces = []
    if (referral.patient?.dob) pieces.push(`DOB ${referral.patient.dob}`)
    for (const key of ['primaryPhone', 'secondaryPhone', 'alternatePhone']) {
        const value = displayPhone(referral.patient?.[key])
        if (value && /\d{3}-\d{3}-\d{4}/.test(value)) pieces.push(`#${value}`)
    }
    return pieces.length ? pieces.join(' ') : '-'
}

function attyCell(attorney = '') {
    const firm = String(attorney || '').trim().toUpperCase()
    if (!firm) return ''
    return firm.startsWith('ATTY') ? firm : `ATTY, ${firm}`
}

/**
 * referral -> array of sheet rows (one per study), first row carries the
 * shared fields, following rows use SA / '-'.
 */
function buildRowsForReferral(referral) {
    const studies = referral.studies?.length ? referral.studies : [{ description: 'UNKNOWN STUDY' }]
    const recdDate = formatDateMDY(referral.createdAt || new Date())
    const fileNumber = [referral.emailSubject, referral.attachmentName].filter(Boolean).join('; ').slice(0, 180)
    const intake = process.env.SHEET_INTAKE_TAG || `AI ${new Date().getFullYear()}`
    const biller = process.env.SHEET_BILLER_DEFAULT || 'DIRECT'
    const fc = process.env.SHEET_FC_DEFAULT || 'LOP'
    const statNote = referral.stat ? 'STAT ' : ''

    return studies.map((study, index) => {
        const first = index === 0
        const row = new Array(COLUMNS).fill('')
        row[COL.FACILITY] = (referral.facility || '').toUpperCase()
        row[COL.PATIENT] = sheetName(referral.patient?.firstName, referral.patient?.lastName)
        row[COL.STUDY] = String(study.description || '').toUpperCase()
        row[COL.DOB_PHONE] = first ? dobPhoneCell(referral) : '-'
        row[COL.REF_DOC] = refDocName(referral.doctor?.name)
        row[COL.RECD_DATE] = recdDate
        row[COL.FILE_NUMBER] = first ? fileNumber : 'SA'
        row[COL.CALL_LOG] = first ? noteStamp(`${statNote}PENDING`) : 'SA'
        row[COL.INTAKE] = intake
        row[COL.BILLER] = biller
        row[COL.ATTY] = attyCell(referral.attorney)
        row[COL.CAT] = categoryForStudy(study.description)
        row[COL.MONTH] = monthTag(referral.createdAt || new Date())
        row[COL.UNITS] = 1
        row[COL.FC] = fc
        return row
    })
}

module.exports = { COLUMNS, COL, HEADER, buildRowsForReferral, categoryForStudy, refDocName, dobPhoneCell, attyCell }
