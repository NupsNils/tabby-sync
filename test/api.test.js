import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { openDb, createDevice } from '../src/db.js'
import { createServer } from '../src/server.js'
import { restoreVersion, listVersions, main } from '../src/cli.js'

const profiles = (...ids) => yaml.dump({ profiles: ids.map((id) => ({ id, name: id })) })
const ids = (content) => (yaml.load(content).profiles ?? []).map((p) => p.id).sort()

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tabbysync-'))
  const dbPath = join(dir, 'test.db')
  const db = openDb(dbPath)
  const server = createServer({ db, maxDeletes: 5 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const call = async (method, path, token, body) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  const client = (name) => {
    const { id, token } = createDevice(db, name)
    const c = {
      id,
      token,
      content: '{}',
      last: null,
      downloads: 0,
      async upload(content = c.content) {
        c.content = content
        const got = await call('GET', '/api/1/configs/1', token)
        const res = await call('PATCH', '/api/1/configs/1', token, { content, last_used_with_version: '1.0.0' })
        assert.equal(got.status, 200)
        assert.equal(res.status, 200)
        c.last = res.body.modified_at
        return res.body
      },
      async poll() {
        const got = await call('GET', '/api/1/configs/1', token)
        if (c.last !== null && !(got.body.modified_at > c.last)) return false
        const full = await call('GET', '/api/1/configs/1', token)
        c.downloads++
        c.content = full.body.content
        await c.upload()
        return true
      },
    }
    return c
  }
  const ready = async (...names) => {
    const clients = names.map(client)
    await call('POST', '/api/1/configs', clients[0].token, { name: 'main' })
    return clients
  }
  return { db, dbPath, call, client, ready }
}

test('auth: missing, bad and revoked tokens give 401, health is open', async (t) => {
  const { db, call } = await setup(t)
  const dev = createDevice(db, 'a')
  assert.equal((await call('GET', '/api/1/user')).status, 401)
  assert.equal((await call('GET', '/api/1/user', 'nope')).status, 401)
  assert.equal((await call('GET', '/api/1/user', dev.token)).status, 200)
  assert.deepEqual((await call('GET', '/health')).body, { ok: true })
  db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(dev.id)
  assert.equal((await call('GET', '/api/1/user', dev.token)).status, 401)
})

test('token is stored only as hash', async (t) => {
  const { db, dbPath } = await setup(t)
  const { token } = createDevice(db, 'a')
  const row = db.prepare('SELECT token_hash FROM devices').get()
  assert.notEqual(row.token_hash, token)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  assert.ok(!readFileSync(dbPath).includes(token))
})

test('user endpoint', async (t) => {
  const { client, call } = await setup(t)
  const a = client('a')
  const { status, body } = await call('GET', '/api/1/user', a.token)
  assert.equal(status, 200)
  assert.equal(body.username, 'tabbysync')
  assert.equal(body.is_pro, false)
})

test('create and list configs', async (t) => {
  const { client, call } = await setup(t)
  const a = client('a')
  const blank = await call('POST', '/api/1/configs/', a.token, { name: ' ' })
  assert.equal(blank.status, 201)
  assert.match(blank.body.name, /^Unnamed config \(\d{4}-\d{2}-\d{2}\)$/)
  assert.equal(blank.body.content, '{}')
  assert.equal(blank.body.user, 1)
  assert.match(blank.body.created_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  await call('POST', '/api/1/configs', a.token, { name: 'second' })
  const list = await call('GET', '/api/1/configs', a.token)
  assert.deepEqual(list.body.map((c) => c.name).slice(1), ['second'])
  assert.equal((await call('GET', '/api/1/configs/99', a.token)).status, 404)
})

test('two devices adding different profiles both end up with both', async (t) => {
  const { call, ready } = await setup(t)
  const [a, b] = await ready('a', 'b')
  await Promise.all([a.upload(profiles('pa')), b.upload(profiles('pb'))])
  const server = await call('GET', '/api/1/configs/1', a.token)
  assert.deepEqual(ids(server.body.content), ['pa', 'pb'])
  for (const c of [a, b]) await c.poll()
  await a.poll()
  assert.deepEqual(ids(a.content), ['pa', 'pb'])
  assert.deepEqual(ids(b.content), ['pa', 'pb'])
})

test('intended deletion propagates', async (t) => {
  const { call, ready } = await setup(t)
  const [a, b] = await ready('a', 'b')
  await a.upload(profiles('p1', 'p2'))
  await b.poll()
  await a.upload(profiles('p2'))
  assert.equal(await b.poll(), true)
  assert.deepEqual(ids(b.content), ['p2'])
  assert.deepEqual(ids((await call('GET', '/api/1/configs/1', a.token)).body.content), ['p2'])
})

test('stale upload lacking an unseen profile keeps it', async (t) => {
  const { call, ready } = await setup(t)
  const [a, b] = await ready('a', 'b')
  await b.upload(profiles('pb'))
  await a.upload(profiles('pb', 'pa'))
  await b.upload(profiles('pb'))
  assert.deepEqual(ids((await call('GET', '/api/1/configs/1', b.token)).body.content), ['pa', 'pb'])
})

test('timestamp trick: minus 1ms when merge changed, exact otherwise', async (t) => {
  const { call, ready } = await setup(t)
  const [a, b] = await ready('a', 'b')
  await a.upload(profiles('pa'))
  const merged = await b.upload(profiles('pb'))
  const stored = await call('GET', '/api/1/configs/1', b.token)
  assert.equal(Date.parse(stored.body.modified_at) - Date.parse(merged.modified_at), 1)
  assert.deepEqual(ids(stored.body.content), ['pa', 'pb'])
  assert.equal(await b.poll(), true)
  const exact = await b.upload()
  const after = await call('GET', '/api/1/configs/1', b.token)
  assert.equal(exact.modified_at, after.body.modified_at)
})

test('no download/upload loop after sync', async (t) => {
  const { ready } = await setup(t)
  const [a, b] = await ready('a', 'b')
  await a.upload(profiles('pa'))
  await b.upload(profiles('pb'))
  for (let i = 0; i < 3; i++) {
    await a.poll()
    await b.poll()
  }
  const downloads = a.downloads + b.downloads
  assert.equal(await a.poll(), false)
  assert.equal(await b.poll(), false)
  assert.equal(a.downloads + b.downloads, downloads)
  assert.deepEqual(ids(a.content), ids(b.content))
})

test('mass deletion is rejected and triggers a download', async (t) => {
  const { db, call, ready } = await setup(t)
  const [a] = await ready('a')
  const all = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']
  await a.upload(profiles(...all))
  const res = await a.upload(profiles('p1', 'p2'))
  const server = await call('GET', '/api/1/configs/1', a.token)
  assert.deepEqual(ids(server.body.content), [...all].sort())
  assert.equal(Date.parse(server.body.modified_at) - Date.parse(res.modified_at), 1)
  const rejected = db.prepare('SELECT * FROM versions WHERE rejected = 1').all()
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].kind, 'upload')
  assert.deepEqual(ids(rejected[0].content), ['p1', 'p2'])
  assert.equal(await a.poll(), true)
  assert.deepEqual(ids(a.content), [...all].sort())
})

test('restore via CLI brings back an earlier version and bumps modified_at', async (t) => {
  const { db, call, ready } = await setup(t)
  const [a] = await ready('a')
  await a.upload(profiles('p1', 'p2'))
  await a.upload(profiles('p2'))
  const before = (await call('GET', '/api/1/configs/1', a.token)).body
  const old = listVersions(db, 1).find((v) => v.kind === 'result' && v.profiles === 2)
  restoreVersion(db, old.id)
  const after = (await call('GET', '/api/1/configs/1', a.token)).body
  assert.deepEqual(ids(after.content), ['p1', 'p2'])
  assert.ok(after.modified_at > before.modified_at)
  assert.equal(listVersions(db, 1).at(-1).kind, 'restore')
  assert.equal(await a.poll(), true)
  assert.deepEqual(ids(a.content), ['p1', 'p2'])
})

test('history records every upload', async (t) => {
  const { db, ready } = await setup(t)
  const [a, b] = await ready('a', 'b')
  await a.upload(profiles('p1'))
  await b.upload(profiles('p2'))
  await a.upload(profiles('p1'))
  const uploads = listVersions(db, 1).filter((v) => v.kind === 'upload')
  assert.deepEqual(uploads.map((v) => v.device), ['a', 'b', 'a'])
})

test('cli main: usage, device add, list', async (t) => {
  const { db } = await setup(t)
  const lines = []
  assert.equal(main(['bogus'], db, (l) => lines.push(l)), 1)
  assert.equal(main(['device', 'add', 'laptop'], db, (l) => lines.push(l)), 0)
  assert.match(lines.at(-1), /Settings/)
  main(['device', 'list'], db, (l) => lines.push(l))
  assert.match(lines.at(-1), /laptop/)
})

test('DELETE is forbidden', async (t) => {
  const { call, ready } = await setup(t)
  const [a] = await ready('a')
  const res = await call('DELETE', '/api/1/configs/1', a.token)
  assert.equal(res.status, 403)
  assert.match(res.body.detail, /CLI/)
  assert.equal((await call('GET', '/api/1/configs/1', a.token)).status, 200)
})

test('invalid YAML and invalid JSON give 400, oversized body 413', async (t) => {
  const { call, ready } = await setup(t)
  const [a] = await ready('a')
  assert.equal((await call('PATCH', '/api/1/configs/1', a.token, { content: 'a: [unclosed' })).status, 400)
  assert.equal((await call('PATCH', '/api/1/configs/1', a.token, '{not json')).status, 400)
  assert.equal((await call('GET', '/api/1/nothing', a.token)).status, 404)
  const big = { content: 'x'.repeat(11 * 1024 * 1024) }
  const res = await call('PATCH', '/api/1/configs/1', a.token, big).catch(() => ({ status: 413 }))
  assert.equal(res.status, 413)
})
