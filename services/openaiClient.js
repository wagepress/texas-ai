const fs = require('fs')
const path = require('path')
const { Agent, run, setDefaultOpenAIKey } = require('@openai/agents')
const { z } = require('zod')

/**
 * Single choke-point for every non-realtime OpenAI call in the app.
 * The realtime voice agent lives in sockets/voiceStream.js.
 */

let keyApplied = false

function ensureConfigured() {
    if (!process.env.OPENAI_API_KEY) {
        const err = new Error('OpenAI is not configured. Set OPENAI_API_KEY.')
        err.statusCode = 503
        throw err
    }
    if (!keyApplied) {
        setDefaultOpenAIKey(process.env.OPENAI_API_KEY)
        keyApplied = true
    }
}

const EXTRACTION_MODEL = () => process.env.OPENAI_EXTRACTION_MODEL || 'gpt-5.1'

// All fields required-but-nullable: OpenAI structured outputs reject optional keys.
const StudySchema = z.object({
    description: z.string().describe('Sheet-style study name, e.g. "MRI CERVICAL", "MRI RT SHOULDER", "CT BRAIN W/O", "XRAY L SPINE"'),
    cpt: z.string().nullable().describe('CPT code printed next to the marked study, e.g. "72141"'),
    laterality: z.string().nullable().describe('"RT", "LT", "BILATERAL" or null'),
    contrast: z.string().nullable().describe('"W/O", "W + W/O", "W" or null'),
})

const SlipSchema = z.object({
    patient: z.object({
        firstName: z.string().nullable(),
        lastName: z.string().nullable(),
        dob: z.string().nullable().describe('MM/DD/YYYY'),
        ssn: z.string().nullable(),
        primaryPhone: z.string().nullable(),
        secondaryPhone: z.string().nullable(),
        alternatePhone: z.string().nullable(),
        insuredName: z.string().nullable(),
        insuranceName: z.string().nullable(),
        planName: z.string().nullable(),
        memberId: z.string().nullable().describe('ID# field'),
        groupNumber: z.string().nullable(),
    }),
    attorney: z.string().nullable().describe('Workers Comp Carrier / Ins. Co. Carrier / Attorney field - usually a law firm name'),
    doctor: z.object({
        name: z.string().nullable(),
        phone: z.string().nullable(),
        fax: z.string().nullable(),
        email: z.string().nullable(),
        npi: z.string().nullable(),
    }),
    facility: z.string().nullable().describe('Short code of the imaging center marked on the slip: GAL, SUGARLAND, I-10, TOMBALL, SPRING, CLIM, SKY, SKY II - or null when none is marked'),
    clinicalFindings: z.string().nullable(),
    stat: z.boolean().describe('true when the STAT box is checked'),
    claustrophobic: z.string().nullable().describe('"YES", "NO" or null'),
    sedation: z.string().nullable(),
    slipDate: z.string().nullable().describe('date written next to the doctor signature, MM/DD/YYYY'),
    comments: z.string().nullable(),
    specialInstructions: z.string().nullable(),
    studies: z.array(StudySchema),
    confidence: z.enum(['high', 'medium', 'low']).describe('low when handwriting or scan quality made key fields (name, phone, studies) uncertain'),
    notes: z.string().nullable().describe('anything ambiguous or unreadable worth flagging to a human'),
})

const ExtractionSchema = z.object({ slips: z.array(SlipSchema) })

const EXTRACTION_INSTRUCTIONS = `You read scanned medical imaging referral slips for Texas Imaging Network (TIN) and return structured data.

The input is a scanned PDF or photo. It contains one or more referral slips. Common formats:
1. TIN order forms (printed or handwritten): header lists imaging centers with a checkbox (Galleria, Sugarland, I-10 MRI & Diagnostics Memorial City, Elite/Tomball, Spring/Woodlands, Clear Lake, Sky Pearland, Sky MRI II I-10 E). Patient block has Name, SS#, DOB, phones, Insured Name, ID#, "Workers Comp. Carrier / Ins. Co. Carrier/Attorney" (usually a law firm), Clinical Findings/Diagnosis, Doctor's Name/Phone/Fax, signature + date. Below is a grid of study checkboxes with CPT codes (MRI, MRA, CT, X-RAY, ultrasound, pain management, etc.). Marked studies may be indicated with X, check marks, circles, or handwriting; the footer or comments line often repeats the order, e.g. "** MRI Cervical - Lumbar - RT Shoulder **" - use it to confirm.
2. Generic "Request for Consultation/Procedure" letters from doctor offices: plain text with patient info and the requested studies with ICD codes.

Rules:
- Return one slip object per DISTINCT patient order. Scans often contain the exact same page twice - collapse exact duplicates into one slip.
- A single slip usually orders MULTIPLE studies - list every marked/requested study.
- Study description must follow the clinic's log style, uppercase: modality first, then body part, e.g. "MRI CERVICAL", "MRI LUMBAR", "MRI RT SHOULDER", "MRI LT KNEE", "CT BRAIN W/O CONTRAST" -> "CT BRAIN W/O", "XRAY C SPINE", "US ABD/PEL/TRANSVAG". Include RT/LT when a side is marked or written.
- For laterality look at the R / L marks next to Knee/Shoulder/Foot/Ankle/Wrist/Hip rows and at handwritten notes ("please MRI the (L) knee").
- facility: the checked imaging-center box, mapped to its short code (Galleria->GAL, Sugarland->SUGARLAND, I-10 Memorial City->I-10, Elite Tomball->TOMBALL, Spring/Woodlands->SPRING, Clear Lake->CLIM, Sky Pearland->SKY, Sky MRI II->SKY II). null when nothing is checked.
- Phone numbers: digits as written, keep them even if formatted oddly.
- Do not invent data. Anything you cannot read goes to null and gets mentioned in notes with confidence lowered.`

let extractionAgent = null

function getExtractionAgent() {
    if (!extractionAgent) {
        extractionAgent = new Agent({
            name: 'TIN slip extractor',
            model: EXTRACTION_MODEL(),
            instructions: EXTRACTION_INSTRUCTIONS,
            outputType: ExtractionSchema,
        })
    }
    return extractionAgent
}

const IMAGE_MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.heic': 'image/heic', '.heif': 'image/heif',
}

function contentItemForFile(filePath, mime = '') {
    const buffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const resolvedMime = mime || IMAGE_MIME_BY_EXT[ext] || (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream')
    const dataUrl = `data:${resolvedMime};base64,${buffer.toString('base64')}`
    if (resolvedMime === 'application/pdf') {
        return { type: 'input_file', file: dataUrl, filename: path.basename(filePath) }
    }
    return { type: 'input_image', image: dataUrl }
}

/**
 * Run the extraction agent over one attachment.
 * Returns the validated { slips: [...] } object.
 */
async function extractSlipsFromFile(filePath, mime = '') {
    ensureConfigured()
    const result = await run(getExtractionAgent(), [{
        role: 'user',
        content: [
            { type: 'input_text', text: 'Extract every referral slip from this scan.' },
            contentItemForFile(filePath, mime),
        ],
    }])
    return result.finalOutput
}

module.exports = { ensureConfigured, extractSlipsFromFile }
