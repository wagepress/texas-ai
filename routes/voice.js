const router = require('express').Router()
const voice = require('../controllers/voice')

// Twilio webhooks (form-encoded posts, validated in the controller when
// TWILIO_VALIDATE_WEBHOOKS=true)
router.post('/api/voice/answer', voice.answer)
router.post('/api/voice/voicemail', voice.voicemail)
router.post('/api/voice/amd', voice.amd)
router.post('/api/voice/status', voice.status)

module.exports = router
