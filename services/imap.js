const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')

/**
 * Thin wrapper around imapflow. A fresh connection is opened for every poll
 * cycle (and closed after) so a dropped socket can never wedge the poller.
 */

function isConfigured() {
    return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD)
}

function buildClient() {
    if (!isConfigured()) {
        const err = new Error('IMAP is not configured. Set IMAP_HOST, IMAP_USER and IMAP_PASSWORD.')
        err.statusCode = 503
        throw err
    }
    return new ImapFlow({
        host: process.env.IMAP_HOST,
        port: Number(process.env.IMAP_PORT || 993),
        secure: process.env.IMAP_SECURE !== 'false',
        auth: {
            user: process.env.IMAP_USER,
            pass: process.env.IMAP_PASSWORD,
        },
        logger: false,
    })
}

const ATTACHMENT_MIMES = /^(application\/pdf|image\/(jpeg|jpg|png|tiff|webp|heic|heif|gif|bmp))$/i
const ATTACHMENT_EXTS = /\.(pdf|jpe?g|png|tiff?|webp|heic|heif|gif|bmp)$/i
const MIN_IMAGE_BYTES = 10 * 1024 // skip signature/logo images embedded in email bodies

function isSlipAttachment(att) {
    const mime = String(att.contentType || '').toLowerCase()
    const name = String(att.filename || '')
    const matchesType = ATTACHMENT_MIMES.test(mime) || ATTACHMENT_EXTS.test(name)
    if (!matchesType) return false
    const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name)
    if (!isPdf && (att.size || att.content?.length || 0) < MIN_IMAGE_BYTES) return false
    return true
}

/**
 * Fetch all unseen messages from the configured mailbox and mark them seen.
 * Returns [{ messageId, uid, subject, from, date, attachments: [{ filename, contentType, size, content }] }]
 */
async function fetchNewMessages() {
    const client = buildClient()
    const mailbox = process.env.IMAP_MAILBOX || 'INBOX'
    const messages = []
    await client.connect()
    try {
        const lock = await client.getMailboxLock(mailbox)
        try {
            const uids = await client.search({ seen: false }, { uid: true })
            for (const uid of uids || []) {
                const raw = await client.fetchOne(uid, { source: true, uid: true }, { uid: true })
                if (!raw || !raw.source) continue
                const parsed = await simpleParser(raw.source)
                const attachments = (parsed.attachments || [])
                    .filter(isSlipAttachment)
                    .map(att => ({
                        filename: att.filename || `attachment-${uid}`,
                        contentType: String(att.contentType || '').toLowerCase(),
                        size: att.size || att.content?.length || 0,
                        content: att.content,
                    }))
                messages.push({
                    messageId: parsed.messageId || `imap-uid-${mailbox}-${uid}`,
                    uid,
                    subject: parsed.subject || '',
                    from: parsed.from?.text || '',
                    date: parsed.date || new Date(),
                    attachments,
                })
                await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
            }
        } finally {
            lock.release()
        }
    } finally {
        await client.logout().catch(() => { })
    }
    return messages
}

module.exports = { isConfigured, fetchNewMessages }
