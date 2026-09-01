require('dotenv').config()
const express = require('express')
const http = require('http')
const cors = require('cors')
const bodyParser = require('body-parser')

const app = express()
const server = http.createServer(app)

// database + models (registered centrally, workforce-api style)
require('./mongoose')
require('./models/referral')
require('./models/callSession')
require('./models/emailMessage')

app.use(cors())
app.use(bodyParser.json({ limit: '25mb' }))
app.use(bodyParser.urlencoded({ extended: true })) // Twilio webhooks post form-encoded

app.get('/api/health', (req, res) => res.send({ status: true, message: 'texas-ai up' }))

app.use(require('./routes/referral'))
app.use(require('./routes/voice'))

// Twilio media stream <-> OpenAI realtime bridge (raw websocket on /ws/voice)
const { registerVoiceStream } = require('./sockets/voiceStream')
registerVoiceStream(server)

// background loops
const { startEmailPoller } = require('./utils/emailPoller')
const { startExtractionEngine } = require('./utils/extractionEngine')
const { startCallScheduler } = require('./utils/callScheduler')
startEmailPoller()
startExtractionEngine()
startCallScheduler()

const PORT = process.env.PORT || 4000
server.listen(PORT, () => console.log(`texas-ai listening on port ${PORT}`))
