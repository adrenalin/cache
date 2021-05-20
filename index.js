const path = require('path')
const express = require('express')
const errors = require('errors')
const axios = require('axios')
const ServerConfig = require('helpers.js/lib/ServerConfig')
const { buildUrl, castToArray } = require('helpers.js')
const config = new ServerConfig()
config.loadFile(path.join(__dirname, 'config/defaults.yml'), true)
config.loadFile(path.join(__dirname, 'config/local.yml'), true)

const Logger = require('logger')
const logger = new Logger('cache')
logger.setLevel(5)

const pages = {}

const app = express()

const ignoreUrls = castToArray('ignoreUrls').map(url => new RegExp(url))

/**
 * Get remote page
 *
 * @param { string } host             HTTP host name
 * @param { string } url              URL
 * @return { object }                 Cached response or null
 */
const getCached = (host, url) => {
  for (let i = 0; i < ignoreUrls.length; i++) {
    if (url.replace(/.+?\//, '/').match(ignoreUrls)) {
      logger.log('Ignore', url)
      return null
    }
  }

  const id = `${host}${url}`
  const cached = pages[id]
  logger.debug('Check cached for', id)

  if (!cached) {
    logger.log('Cache miss')
    return null
  }

  if (cached.ts < Date.now() - config.get('cache.lifetime') * 1000) {
    logger.log('Expired')
    return null
  }

  logger.log('Got cached', cached)
  return cached
}

/**
 * Get remote page
 *
 * @param { request } req             HTTP request
 * @param { boolean } isRefresh       Is this a refresh request
 * @return { object }                 HTTP response essentials
 */
const getPage = async (req, isRefresh = false) => {
  const originalUrl = req.originalUrl
  const host = req.headers.host

  const url = buildUrl({
    protocol: config.get('remote.protocol'),
    port: config.get('remote.port'),
    host: config.get('remote.host'),
    location: req.originalUrl,
    validateStatus: (status) => {
      return true
    }
  })

  const cached = getCached(host, originalUrl)
  if (cached) {
    if (req.headers.etag && cached.etag === req.headers.etag) {
      logger.log('Etag hit')
      return {
        status: 304,
        headers: cached.headers,
        body: ''
      }
    }

    logger.log('Etag miss, serve cached as new')

    if (!isRefresh) {
      return cached
    }
  }

  logger.log('Get URL', url)
  const response = await axios({
    method: req.method,
    url: url,
    headers: req.headers,
    timeout: config.get('remote.timeout', 30) * 1000,
    responseType: 'text'
  })

  const headers = req.headers

  for (const key in headers) {
    if (['set-cookie'].includes(key)) {
      delete headers[key]
    }
  }

  const etag = response.headers.etag || ''
  const body = response.body || response.data
  const status = response.status || 200

  logger.log('Got response', status)

  const requestUrl = `${req.headers.host}${req.originalUrl}`
  const page = {
    host,
    originalUrl,
    status,
    etag,
    ts: Date.now(),
    headers,
    body
  }

  // Strong etag found, store to cache
  if (etag && !etag.match(/^w/i)) {
    pages[requestUrl] = page
  }

  return page
}

app.use(async (req, res, next) => {
  try {
    const page = await getPage(req)
    res.status(page.status || 200)

    for (const key in page.headers) {
      res.header(key, page.headers[key])
    }

    res.send(page.body)
  } catch (err) {
    logger.log('Caught err', err)
    res
      .status(err.statusCode || 503)
      .json({
        status: 'error',
        message: err.message
      })
  }
})

const port = config.get('server.port', 3000)
app.listen(port)
logger.info('Listening to', port)

setInterval(async () => {
  logger.debug('Deleting expired from memory')
  for (const id in pages) {
    const cached = getCached(pages[id].host, pages[id].originalUrl)

    if (!cached) {
      logger.log(id, 'has expired')
      delete pages[id]
    }
  }
}, 60000)
