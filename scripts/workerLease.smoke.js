/**
 * Smoke test for background-loop leadership across overlapping processes.
 * Needs a local MongoDB only. Run: node scripts/workerLease.smoke.js
 */
process.env.DB = process.env.DB || 'mongodb://localhost:27017/texas-ai-lease-smoke'

const assert = require('assert')
const mongoose = require('mongoose')
require('../mongoose')
require('../models/workerLease')
const { createLease } = require('../utils/workerLease')

async function main() {
    await mongoose.connection.asPromise()
    await mongoose.connection.dropDatabase()

    const oldRevision = createLease('rev-001', new Date(Date.now() - 60 * 60 * 1000))
    assert.strictEqual(await oldRevision(), true, 'first process takes the lease')
    assert.strictEqual(await oldRevision(), true, 'holder keeps it')

    const newRevision = createLease('rev-002', new Date())
    assert.strictEqual(await newRevision(), true, 'newer process takes over immediately')
    assert.strictEqual(await oldRevision(), false, 'draining process goes quiet')
    assert.strictEqual(await newRevision(), true, 'new holder keeps it')

    // holder dies: its heartbeat goes stale and the older survivor may take over
    await mongoose.model('workerLeases').updateOne({ _id: 'background' }, { $set: { heartbeatAt: new Date(Date.now() - 5 * 60 * 1000) } })
    assert.strictEqual(await oldRevision(), true, 'stale lease is taken over')

    const both = await Promise.all([createLease('a', new Date(Date.now() + 1000))(), createLease('b', new Date(Date.now() + 2000))()])
    assert.ok(both.filter(Boolean).length >= 1, 'concurrent starters: someone holds it')

    await mongoose.connection.dropDatabase()
    console.log('workerLease.smoke: all assertions passed')
    await mongoose.disconnect()
}

main().catch(err => {
    console.error('workerLease.smoke FAILED:', err)
    process.exit(1)
})
