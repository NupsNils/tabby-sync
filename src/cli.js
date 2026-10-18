import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { openDb, createDevice, addVersion, transaction } from './db.js'

const iso = (ms) => new Date(ms).toISOString()

export function countProfiles(content) {
  try {
    const profiles = yaml.load(content)?.profiles
    return Array.isArray(profiles) ? profiles.length : 0
  } catch {
    return 0
  }
}

export const addDevice = createDevice

export const listDevices = (db) => db.prepare('SELECT id, name, created_at, revoked FROM devices ORDER BY id').all()

export function revokeDevice(db, id) {
  return db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(id).changes > 0
}

export const listConfigs = (db) =>
  db
    .prepare('SELECT id, name, content, modified_at FROM configs ORDER BY id')
    .all()
    .map(({ content, ...c }) => ({ ...c, profiles: countProfiles(content) }))

export const listVersions = (db, configId) =>
  db
    .prepare(
      `SELECT v.id, v.kind, v.rejected, d.name AS device, v.created_at, v.content
       FROM versions v LEFT JOIN devices d ON d.id = v.device_id
       WHERE v.config_id = ? ORDER BY v.id`,
    )
    .all(configId)
    .map(({ content, ...v }) => ({ ...v, profiles: countProfiles(content) }))

export function restoreVersion(db, versionId) {
  return transaction(db, () => {
    const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId)
    if (!version) throw new Error(`Version ${versionId} not found`)
    const config = db.prepare('SELECT * FROM configs WHERE id = ?').get(version.config_id)
    const modifiedAt = Math.max(Date.now(), config.modified_at + 2)
    const restored = addVersion(db, config.id, null, 'restore', version.content)
    db.prepare('UPDATE configs SET content = ?, modified_at = ?, current_version = ? WHERE id = ?').run(
      version.content,
      modifiedAt,
      restored,
      config.id,
    )
    return { configId: config.id, version: restored, modifiedAt }
  })
}

const USAGE = `Usage:
  device add <name>
  device list
  device revoke <id>
  config list
  versions <configId>
  restore <versionId>`

export function main(argv, db, out = console.log) {
  const [cmd, sub, arg] = argv
  if (cmd === 'device' && sub === 'add' && arg) {
    const { id, token } = addDevice(db, arg)
    out(`Device ${id} "${arg}" created. Token (shown only once):\n\n${token}\n\nPaste it into Tabby: Settings -> Config sync -> Token.`)
  } else if (cmd === 'device' && sub === 'list') {
    listDevices(db).forEach((d) => out(`${d.id}\t${d.name}\t${iso(d.created_at)}\t${d.revoked ? 'revoked' : 'active'}`))
  } else if (cmd === 'device' && sub === 'revoke' && arg) {
    out(revokeDevice(db, Number(arg)) ? `Device ${arg} revoked.` : `Device ${arg} not found.`)
  } else if (cmd === 'config' && sub === 'list') {
    listConfigs(db).forEach((c) => out(`${c.id}\t${c.name}\t${iso(c.modified_at)}\t${c.profiles} profiles`))
  } else if (cmd === 'versions' && sub) {
    listVersions(db, Number(sub)).forEach((v) =>
      out(`${v.id}\t${v.kind}\t${v.rejected ? 'rejected' : 'ok'}\t${v.device ?? '-'}\t${iso(v.created_at)}\t${v.profiles} profiles`),
    )
  } else if (cmd === 'restore' && sub) {
    const r = restoreVersion(db, Number(sub))
    out(`Config ${r.configId} restored from version ${sub} (new version ${r.version}). Devices download it on their next poll.`)
  } else {
    out(USAGE)
    return 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env.DB_PATH ?? './data/tabbysync.db')
  try {
    process.exitCode = main(process.argv.slice(2), db)
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
