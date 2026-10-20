import http from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, findDevice, addVersion, transaction } from './db.js'
import { mergeConfig, sameContent } from './merge.js'

const MAX_BODY = 10 * 1024 * 1024

class HttpError extends Error {
  constructor(status, detail) {
    super(detail)
    this.status = status
    this.detail = detail
  }
}

const configJson = (c, modifiedAt = c.modified_at) => ({
  id: c.id,
  user: 1,
  name: c.name,
  content: c.content,
  last_used_with_version: c.last_used_with_version,
  created_at: new Date(c.created_at).toISOString(),
  modified_at: new Date(modifiedAt).toISOString(),
})

const USER = {
  id: 1,
  username: 'tabbysync',
  active_config: null,
  custom_connection_gateway: null,
  custom_connection_gateway_token: null,
  config_sync_token: '',
  is_pro: false,
  is_sponsor: false,
  github_username: null,
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

export function createServer({ db, maxDeletes = 5, maxDeletePercent = 50 }) {
  const getConfig = (id) => {
    const config = db.prepare('SELECT * FROM configs WHERE id = ?').get(id)
    if (!config) throw new HttpError(404, 'Not found')
    return config
  }

  const getState = (deviceId, configId) =>
    db.prepare('SELECT * FROM device_state WHERE device_id = ? AND config_id = ?').get(deviceId, configId)

  const setState = (deviceId, configId, base, pending) =>
    db
      .prepare(
        `INSERT INTO device_state (device_id, config_id, base_version, pending_version) VALUES (?, ?, ?, ?)
         ON CONFLICT (device_id, config_id) DO UPDATE SET base_version = excluded.base_version, pending_version = excluded.pending_version`,
      )
      .run(deviceId, configId, base, pending)

  function createConfig(body) {
    const name = typeof body.name === 'string' && body.name.trim() ? body.name : `Unnamed config (${new Date().toISOString().slice(0, 10)})`
    const now = Date.now()
    return transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO configs (name, content, created_at, modified_at) VALUES (?, ?, ?, ?)')
        .run(name, '{}', now, now)
      const id = Number(lastInsertRowid)
      const version = addVersion(db, id, null, 'result', '{}')
      db.prepare('UPDATE configs SET current_version = ? WHERE id = ?').run(version, id)
      return getConfig(id)
    })
  }

  function downloadConfig(device, id) {
    const config = getConfig(id)
    const state = getState(device.id, id)
    const base = state ? (state.pending_version ?? state.base_version) : null
    setState(device.id, id, base, config.current_version)
    return config
  }

  function uploadConfig(device, id, body) {
    return transaction(db, () => {
      let config = getConfig(id)
      if (typeof body.name === 'string') db.prepare('UPDATE configs SET name = ? WHERE id = ?').run(body.name, id)
      if (body.last_used_with_version != null) {
        db.prepare('UPDATE configs SET last_used_with_version = ? WHERE id = ?').run(String(body.last_used_with_version), id)
      }
      let changed = false
      let rejected = false
      if (typeof body.content === 'string') {
        const state = getState(device.id, id)
        const baseRow = state?.base_version && db.prepare('SELECT content FROM versions WHERE id = ?').get(state.base_version)
        let merge
        try {
          merge = mergeConfig(baseRow?.content ?? null, config.content, body.content, { maxDeletes, maxDeletePercent })
        } catch (err) {
          throw new HttpError(400, `Invalid YAML: ${err.message}`)
        }
        ;({ changed, rejected } = merge)
        const upload = addVersion(db, id, device.id, 'upload', body.content, rejected ? 1 : 0, merge.vaultConflict ? 1 : 0)
        if (merge.vaultConflict) {
          console.log(`vault conflict: config ${id}, device ${device.name}; server vault kept, uploaded vault saved as version ${upload}`)
        }
        if (rejected) {
          console.log(
            `upload rejected: config ${id}, device ${device.name}, ${merge.deleted} profiles / ${merge.deletedGroups} groups deleted; saved as version ${upload}`,
          )
        }
        if (!rejected && !sameContent(merge.content, config.content)) {
          const modifiedAt = Math.max(Date.now(), config.modified_at + 2)
          const result = addVersion(db, id, device.id, 'result', merge.content)
          db.prepare('UPDATE configs SET content = ?, modified_at = ?, current_version = ? WHERE id = ?').run(
            merge.content,
            modifiedAt,
            result,
            id,
          )
        }
        setState(device.id, id, upload, null)
      }
      config = getConfig(id)
      return configJson(config, changed || rejected ? config.modified_at - 1 : config.modified_at)
    })
  }

  async function route(req, device, path) {
    const method = req.method
    if (path === '/api/1/user' && method === 'GET') return [200, USER]
    if (path === '/api/1/configs') {
      if (method === 'GET') return [200, db.prepare('SELECT * FROM configs ORDER BY id').all().map((c) => configJson(c))]
      if (method === 'POST') return [201, configJson(createConfig(await readJson(req)))]
    }
    const match = path.match(/^\/api\/1\/configs\/(\d+)$/)
    if (match) {
      const id = Number(match[1])
      if (method === 'GET') return [200, configJson(downloadConfig(device, id))]
      if (method === 'PATCH') return [200, uploadConfig(device, id, await readJson(req))]
      if (method === 'DELETE') throw new HttpError(403, 'Deleting configs is disabled on this server. Use the CLI.')
    }
    throw new HttpError(404, 'Not found')
  }

  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname.replace(/(.)\/$/, '$1')
    let status = 500
    let body = { detail: 'Internal server error' }
    let device
    try {
      if (path === '/health' && req.method === 'GET') {
        status = 200
        body = { ok: true }
      } else {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
        device = token && findDevice(db, token)
        if (!device) throw new HttpError(401, 'Invalid or missing token')
        ;[status, body] = await route(req, device, path)
      }
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status
        body = { detail: err.detail }
      } else {
        console.error(`${req.method} ${path} error: ${err.message}`)
      }
    }
    console.log(`${req.method} ${path} ${status} ${device?.name ?? '-'}`)
    res.writeHead(status, { 'Content-Type': 'application/json', Connection: status === 413 ? 'close' : 'keep-alive' })
    res.end(JSON.stringify(body))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env.DB_PATH ?? './data/tabbysync.db')
  const maxDeletes = Number(process.env.MAX_PROFILE_DELETES ?? 5)
  const maxDeletePercent = Number(process.env.MAX_DELETE_PERCENT ?? 50)
  const port = Number(process.env.PORT ?? 8080)
  createServer({ db, maxDeletes, maxDeletePercent }).listen(port, () => console.log(`TabbySync listening on :${port}`))
}
