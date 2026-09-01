/**
 * Write the TIN ALL header row into the Google Sheet if the tab is empty.
 * Usage: node scripts/seedSheetHeader.js
 * Requires GOOGLE_SHEET_ID + service account credentials in .env
 */
require('dotenv').config()
const googleSheets = require('../services/googleSheets')
const { HEADER } = require('../utils/sheetRows')

async function main() {
    const existing = await googleSheets.getHeaderRow()
    if (existing.length) {
        console.log('header already present, leaving the sheet untouched:', existing.slice(0, 5).join(' | '), '...')
        return
    }
    await googleSheets.appendRows([HEADER])
    console.log(`header row written to "${googleSheets.tabName()}"`)
}

main().catch(err => {
    console.error('seed failed:', err.message)
    process.exit(1)
})
