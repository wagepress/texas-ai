const mongoose = require('mongoose')

/**
 * Which process runs the background loops (email poller, extraction, call
 * scheduler). During a deploy the old and new Cloud Run revisions overlap for
 * ~15-20 minutes; only the lease holder does work. See utils/workerLease.js.
 */
const workerLeaseSchema = new mongoose.Schema({
    _id: { type: String },
    holder: { type: String, default: '' },
    holderStartedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
}, { timestamps: true })

mongoose.model('workerLeases', workerLeaseSchema)
