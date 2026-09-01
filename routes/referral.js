const router = require('express').Router()
const referral = require('../controllers/referral')
const { apiKeyAuth } = require('../middlewares/apiKeyAuth')

router.post('/api/referral/list', apiKeyAuth, referral.list)
router.get('/api/referral/detail/:id', apiKeyAuth, referral.detail)
router.get('/api/referral/stats', apiKeyAuth, referral.stats)
router.post('/api/referral/retry-extraction/:id', apiKeyAuth, referral.retryExtraction)
router.post('/api/referral/call-now/:id', apiKeyAuth, referral.callNow)
router.post('/api/referral/poll-email', apiKeyAuth, referral.pollEmail)
router.post('/api/call/list', apiKeyAuth, referral.callList)

module.exports = router
