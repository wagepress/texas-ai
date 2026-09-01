const { ADMIN_API_KEY } = require('../config')

/**
 * Simple shared-secret guard for the admin endpoints. This service has no
 * user accounts - operations staff call it with the x-api-key header.
 * Fails closed when ADMIN_API_KEY is not configured.
 */
function apiKeyAuth(req, res, next) {
    if (!ADMIN_API_KEY) return res.status(503).send({ status: false, message: 'ADMIN_API_KEY is not configured on the server' })
    if (req.headers['x-api-key'] !== ADMIN_API_KEY) return res.status(401).send({ status: false, message: 'Invalid API key' })
    next()
}

module.exports = { apiKeyAuth }
