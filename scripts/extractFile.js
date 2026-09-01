/**
 * Run the OpenAI extraction agent against a local slip file (no DB needed).
 * Usage: node scripts/extractFile.js /path/to/slip.pdf
 * Requires OPENAI_API_KEY in .env
 */
require('dotenv').config()
const { extractSlipsFromFile } = require('../services/openaiClient')

async function main() {
    const filePath = process.argv[2]
    if (!filePath) {
        console.error('Usage: node scripts/extractFile.js <path-to-pdf-or-image>')
        process.exit(1)
    }
    console.log('extracting', filePath, '...')
    const result = await extractSlipsFromFile(filePath)
    console.log(JSON.stringify(result, null, 2))
    console.log(`\n${result.slips.length} slip(s) found`)
}

main().catch(err => {
    console.error('extraction failed:', err)
    process.exit(1)
})
