import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS configs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  last_used_with_version TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  current_version INTEGER
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY,
  config_id INTEGER NOT NULL REFERENCES configs(id),
  device_id INTEGER REFERENCES devices(id),
  kind TEXT NOT NULL CHECK (kind IN ('result', 'upload', 'restore')),
  rejected INTEGER NOT NULL DEFAULT 0,
  vault_conflict INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_state (
  device_id INTEGER NOT NULL REFERENCES devices(id),
  config_id INTEGER NOT NULL REFERENCES configs(id),
  base_version INTEGER,
  pending_version INTEGER,
  PRIMARY KEY (device_id, config_id)
);
`

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  if (!db.prepare('PRAGMA table_info(versions)').all().some((c) => c.name === 'vault_conflict')) {
    db.exec('ALTER TABLE versions ADD COLUMN vault_conflict INTEGER NOT NULL DEFAULT 0')
  }
  return db
}

export const hashToken = (token) => createHash('sha256').update(token).digest('hex')

export function createDevice(db, name) {
  const token = randomBytes(32).toString('base64url')
  const { lastInsertRowid } = db
    .prepare('INSERT INTO devices (name, token_hash, created_at) VALUES (?, ?, ?)')
    .run(name, hashToken(token), Date.now())
  return { id: Number(lastInsertRowid), token }
}

export function findDevice(db, token) {
  return db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0').get(hashToken(token))
}

export function addVersion(db, configId, deviceId, kind, content, rejected = 0, vaultConflict = 0) {
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO versions (config_id, device_id, kind, rejected, vault_conflict, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(configId, deviceId, kind, rejected, vaultConflict, content, Date.now())
  return Number(lastInsertRowid)
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
