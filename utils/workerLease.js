const os = require('os')
const mongoose = require('mongoose')

const WorkerLease = () => mongoose.model('workerLeases')

const LEASE_ID = 'background'
// a holder that hasn't ticked for this long is presumed dead
const STALE_MS = 90 * 1000

/**
 * Background-loop leadership. The most recently started process wins right
 * away, so after a deploy the new revision takes over and the draining one
 * (old code, and a disk without the new uploads) goes quiet. A crashed holder
 * is replaced once its heartbeat goes stale.
 */
function createLease(holder, startedAt) {
    return async function isActiveWorker() {
        const now = new Date()
        try {
            const doc = await WorkerLease().findOneAndUpdate(
                {
                    _id: LEASE_ID,
                    $or: [
                        { holder },
                        { heartbeatAt: { $lt: new Date(now.getTime() - STALE_MS) } },
                        { holderStartedAt: { $lt: startedAt } },
                    ],
                },
                { $set: { holder, holderStartedAt: startedAt, heartbeatAt: now } },
                { upsert: true, returnDocument: 'after' }
            )
            return doc?.holder === holder
        } catch (err) {
            // filter didn't match an existing lease -> the upsert collides on _id: someone newer holds it
            if (err?.code === 11000) return false
            throw err
        }
    }
}

const STARTED_AT = new Date()
const isActiveWorker = createLease(`${process.env.K_REVISION || os.hostname()}-${process.pid}-${STARTED_AT.getTime()}`, STARTED_AT)

module.exports = { isActiveWorker, createLease }
