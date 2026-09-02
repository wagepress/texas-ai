/**
 * Apply the clinic workbook design ("TIN LOG FORMAT" xlsx) to the live tab:
 * header row text + blue/yellow fills, Trebuchet MS 9 everywhere, frozen
 * header + A-H columns, and the workbook's column widths.
 * Usage: node scripts/formatSheet.js
 * Requires GOOGLE_SHEET_ID + service account credentials in .env
 */
require('dotenv').config()
const googleSheets = require('../services/googleSheets')
const { HEADER } = require('../utils/sheetRows')

const HEADER_BLUE = { red: 0xB3 / 255, green: 0xCE / 255, blue: 0xFB / 255 }
const HEADER_YELLOW = { red: 0xF7 / 255, green: 0xE6 / 255, blue: 0xAD / 255 }
const FONT = { fontFamily: 'Trebuchet MS', fontSize: 9 }

// Excel column widths from the workbook, converted to pixels (width * 7 + 5)
const COLUMN_WIDTHS = {
    A: 66, B: 76, C: 154, D: 153, E: 118, F: 147, G: 83, H: 128, I: 93, J: 101,
    K: 303, L: 111, M: 108, N: 138, O: 91, P: 69, S: 230, T: 317, U: 72, V: 107, W: 69,
}

function columnIndex(letter) {
    return letter.split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1
}

async function main() {
    const sheets = googleSheets.getSheets()
    const spreadsheetId = googleSheets.spreadsheetId()

    const meta = await sheets.spreadsheets.get({ spreadsheetId })
    const tab = meta.data.sheets.find(s => s.properties.title === googleSheets.tabName())
    if (!tab) throw new Error(`tab "${googleSheets.tabName()}" not found in spreadsheet`)
    const sheetId = tab.properties.sheetId

    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${googleSheets.tabName()}'!A1:AD1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [HEADER] },
    })

    const requests = [
        // whole-sheet font, without touching bold/colors set elsewhere
        {
            repeatCell: {
                range: { sheetId },
                cell: { userEnteredFormat: { textFormat: FONT } },
                fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize',
            },
        },
        // header row: blue fill, bold, centered, wrapped
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADER.length },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: HEADER_BLUE,
                        textFormat: { ...FONT, bold: true },
                        horizontalAlignment: 'CENTER',
                        verticalAlignment: 'MIDDLE',
                        wrapStrategy: 'WRAP',
                    },
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
            },
        },
        // H (FILE NUMBER) header is yellow in the clinic workbook
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: columnIndex('H'), endColumnIndex: columnIndex('H') + 1 },
                cell: { userEnteredFormat: { backgroundColor: HEADER_YELLOW } },
                fields: 'userEnteredFormat.backgroundColor',
            },
        },
        // workbook freezes at I2: header row + columns A-H
        {
            updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 8 } },
                fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
            },
        },
        ...Object.entries(COLUMN_WIDTHS).map(([letter, pixelSize]) => ({
            updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex(letter), endIndex: columnIndex(letter) + 1 },
                properties: { pixelSize },
                fields: 'pixelSize',
            },
        })),
    ]

    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
    console.log(`formatted "${googleSheets.tabName()}" (${requests.length} formatting request(s) applied)`)
}

main().catch(err => {
    console.error('format failed:', err.message)
    process.exit(1)
})
