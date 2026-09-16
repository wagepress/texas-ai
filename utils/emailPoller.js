const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const imap = require('../services/imap')
const { isActiveWorker } = require('./workerLease')
const { REFERRAL_STATUS } = require('../constants/referralStatus')

const EmailMessage = () => mongoose.model('emailMessages')
const Referral = () => mongoose.model('referrals')

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')
// stay well under MongoDB's 16MB document limit
const MAX_STORED_BYTES = 15 * 1024 * 1024

function safeFilename(name = '') {
    return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'attachment'
}

function saveAttachment(att) {
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.join(UPLOAD_ROOT, day)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeFilename(att.filename)}`)
    fs.writeFileSync(filePath, att.content)
    return filePath
}

/**
 * One poll cycle: pull unseen mail, store slip attachments on disk and create
 * a referral (status: received) per attachment. The extraction engine picks
 * those up on its own loop.
 */
async function pollOnce() {
    const messages = await imap.fetchNewMessages()
    let created = 0
    for (const msg of messages) {
        // ledger dedupe - \Seen flags can be reset on shared mailboxes
        const existing = await EmailMessage().findOne({ messageId: msg.messageId })
        if (existing) continue

        const doc = {
            messageId: msg.messageId,
            uid: msg.uid,
            subject: msg.subject,
            from: msg.from,
            receivedAt: msg.date,
            attachments: [],
            referralIds: [],
            status: msg.attachments.length ? 'processed' : 'no_attachments',
        }
        try {
            for (const att of msg.attachments) {
                const filePath = saveAttachment(att)
                doc.attachments.push({ filename: att.filename, path: filePath, mime: att.contentType, size: att.size })
                const referral = await Referral()({
                    emailMessageId: msg.messageId,
                    emailSubject: msg.subject,
                    emailFrom: msg.from,
                    attachmentPath: filePath,
                    attachmentName: att.filename,
                    attachmentMime: att.contentType,
                    attachmentData: att.content.length <= MAX_STORED_BYTES ? att.content : undefined,
                    status: REFERRAL_STATUS.RECEIVED,
                }).save()
                doc.referralIds.push(referral._id)
                created++
            }
        } catch (err) {
            doc.status = 'error'
            doc.error = err.message
            console.error('emailPoller: failed processing message', msg.messageId, err)
        }
        await EmailMessage()(doc).save().catch(err => {
            // unique-index race with a parallel poll - safe to ignore
            if (err?.code !== 11000) console.error('emailPoller: ledger save failed', err)
        })
    }
    if (messages.length) console.log(`emailPoller: ${messages.length} new message(s), ${created} referral(s) created`)
    return { messages: messages.length, referrals: created }
}

let running = false

function startEmailPoller() {
    if (!imap.isConfigured()) {
        console.log('emailPoller: IMAP env not configured, poller disabled')
        return
    }
    const intervalMs = Number(process.env.EMAIL_POLL_INTERVAL_MS || 60 * 1000)
    const tick = async () => {
        if (running) return
        running = true
        try {
            if (!(await isActiveWorker())) return
            await pollOnce()
        } catch (err) {
            console.error('emailPoller error:', err.message)
        } finally {
            running = false
        }
    }
    tick()
    setInterval(tick, intervalMs)
    console.log(`emailPoller: polling ${process.env.IMAP_USER} every ${intervalMs / 1000}s`)
}

module.exports = { startEmailPoller, pollOnce }
