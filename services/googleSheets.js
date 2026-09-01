const fs = require('fs')
const { google } = require('googleapis')

/**
 * Google Sheets wrapper for the online TIN log. Auth is a service account -
 * share the spreadsheet with the service account's email as an editor.
 * Provide credentials via GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path to key json)
 * or GOOGLE_SERVICE_ACCOUNT_JSON (raw json or base64 json).
 */

let sheetsClient = null

function isConfigured() {
    return !!(process.env.GOOGLE_SHEET_ID &&
        (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_SERVICE_ACCOUNT_JSON))
}

function loadCredentials() {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
        return JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, 'utf8'))
    }
    let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8')
    return JSON.parse(raw)
}

function getSheets() {
    if (!isConfigured()) {
        const err = new Error('Google Sheets is not configured. Set GOOGLE_SHEET_ID and service account credentials.')
        err.statusCode = 503
        throw err
    }
    if (!sheetsClient) {
        const auth = new google.auth.GoogleAuth({
            credentials: loadCredentials(),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        })
        sheetsClient = google.sheets({ version: 'v4', auth })
    }
    return sheetsClient
}

function spreadsheetId() {
    return process.env.GOOGLE_SHEET_ID
}

function tabName() {
    return process.env.GOOGLE_SHEET_TAB || 'TIN ALL'
}

function tabRange(a1) {
    return `'${tabName()}'!${a1}`
}

/**
 * Append rows to the bottom of the log tab.
 * Returns the 1-based row number of the FIRST appended row.
 */
async function appendRows(values) {
    const sheets = getSheets()
    const res = await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId(),
        range: tabRange('A1'),
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
    })
    const updatedRange = res.data?.updates?.updatedRange || ''
    const match = updatedRange.match(/![A-Z]+(\d+)/)
    if (!match) throw new Error(`Could not parse appended range "${updatedRange}"`)
    return Number(match[1])
}

/** cells: [{ row, column: 'I', value }] - one batch write */
async function updateCells(cells) {
    if (!cells.length) return
    const sheets = getSheets()
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: spreadsheetId(),
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: cells.map(cell => ({
                range: tabRange(`${cell.column}${cell.row}`),
                values: [[cell.value]],
            })),
        },
    })
}

async function getCell(row, column) {
    const sheets = getSheets()
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId(),
        range: tabRange(`${column}${row}`),
    })
    return res.data?.values?.[0]?.[0] ?? ''
}

/** Append text to an existing cell (used for the running K-column call log). */
async function appendToCell(row, column, text, separator = ' ') {
    const current = await getCell(row, column)
    const next = current && current !== 'SA' ? `${current}${separator}${text}` : text
    await updateCells([{ row, column, value: next }])
    return next
}

/** Read the first row of the tab (header check for the seed script). */
async function getHeaderRow() {
    const sheets = getSheets()
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId(),
        range: tabRange('A1:AD1'),
    })
    return res.data?.values?.[0] || []
}

module.exports = { isConfigured, getSheets, appendRows, updateCells, getCell, appendToCell, getHeaderRow, tabName, spreadsheetId }
