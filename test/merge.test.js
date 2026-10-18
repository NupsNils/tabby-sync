import { test } from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import { mergeConfig, sameContent } from '../src/merge.js'

const dump = o => (o == null ? o : yaml.dump(o))
const p = (id, extra = {}) => ({ id, name: id, type: 'ssh', ...extra })
const merge = (b, s, u, opts) => {
  const r = mergeConfig(dump(b), dump(s), dump(u), opts)
  return { ...r, cfg: r.rejected ? null : yaml.load(r.content) }
}
const ids = cfg => cfg.profiles.map(x => x.id)

test('two devices add different profiles concurrently: both survive', () => {
  const b = { profiles: [p('a')] }
  const s = { profiles: [p('a'), p('b')] }
  const u = { profiles: [p('a'), p('c')] }
  const r = merge(b, s, u)
  assert.deepEqual(ids(r.cfg), ['a', 'b', 'c'])
  assert.equal(r.changed, true)
  assert.equal(r.deleted, 0)
})

test('intended deletion removes profile from server', () => {
  const b = { profiles: [p('a'), p('b')] }
  const r = merge(b, b, { profiles: [p('a')] })
  assert.deepEqual(ids(r.cfg), ['a'])
  assert.equal(r.deleted, 1)
  assert.equal(r.changed, false)
})

test('profile never seen by device is kept', () => {
  const b = { profiles: [p('a')] }
  const s = { profiles: [p('a'), p('new')] }
  const r = merge(b, s, { profiles: [p('a')] })
  assert.deepEqual(ids(r.cfg), ['a', 'new'])
  assert.equal(r.deleted, 0)
  assert.equal(r.changed, true)
})

test('same profile, different fields changed: both changes kept', () => {
  const b = { profiles: [p('a', { options: { host: 'h1', port: 22 } })] }
  const s = { profiles: [p('a', { options: { host: 'h2', port: 22 } })] }
  const u = { profiles: [p('a', { options: { host: 'h1', port: 2222 } })] }
  const r = merge(b, s, u)
  assert.deepEqual(r.cfg.profiles[0].options, { host: 'h2', port: 2222 })
  assert.equal(r.changed, true)
})

test('same profile, same field changed: upload wins', () => {
  const b = { profiles: [p('a', { name: 'base' })] }
  const s = { profiles: [p('a', { name: 'server' })] }
  const u = { profiles: [p('a', { name: 'upload' })] }
  const r = merge(b, s, u)
  assert.equal(r.cfg.profiles[0].name, 'upload')
  assert.equal(r.changed, false)
})

test('field removed on device while other field changed on server', () => {
  const b = { profiles: [p('a', { color: 'red', icon: 'x' })] }
  const s = { profiles: [p('a', { color: 'red', icon: 'y' })] }
  const u = { profiles: [p('a', { icon: 'x' })] }
  const r = merge(b, s, u)
  assert.deepEqual(r.cfg.profiles[0], p('a', { icon: 'y' }))
})

test('profile deleted by another device and unchanged here stays deleted', () => {
  const b = { profiles: [p('a'), p('b')] }
  const r = merge(b, { profiles: [p('a')] }, b)
  assert.deepEqual(ids(r.cfg), ['a'])
  assert.equal(r.deleted, 0)
  assert.equal(r.changed, true)
})

test('profile deleted by another device but modified here is resurrected', () => {
  const b = { profiles: [p('a'), p('b')] }
  const u = { profiles: [p('a'), p('b', { name: 'edited' })] }
  const r = merge(b, { profiles: [p('a')] }, u)
  assert.deepEqual(r.cfg.profiles, u.profiles)
  assert.equal(r.changed, false)
})

test('order: server order first, then upload-only items', () => {
  const b = { profiles: [p('a'), p('b')] }
  const s = { profiles: [p('b'), p('a'), p('s')] }
  const u = { profiles: [p('u1'), p('a'), p('b'), p('u2')] }
  assert.deepEqual(ids(merge(b, s, u).cfg), ['b', 'a', 's', 'u1', 'u2'])
})

test('groups merged by id, group deletions do not count as profile deletions', () => {
  const g = (id, name = id) => ({ id, name })
  const b = { groups: [g('g1'), g('g2')] }
  const s = { groups: [g('g1', 'renamed'), g('g2'), g('g3')] }
  const u = { groups: [g('g1'), g('g4')] }
  const r = merge(b, s, u)
  assert.deepEqual(r.cfg.groups, [g('g1', 'renamed'), g('g3'), g('g4')])
  assert.equal(r.deleted, 0)
})

test('list items without id fall back to generic merge', () => {
  const b = { profiles: [{ name: 'x' }] }
  const s = { profiles: [{ name: 'y' }] }
  const u = { profiles: [{ name: 'z' }] }
  assert.deepEqual(merge(b, s, u).cfg.profiles, [{ name: 'z' }])
  assert.deepEqual(merge(b, s, b).cfg.profiles, [{ name: 'y' }])
})

test('settings: device change wins, unchanged device setting keeps server value', () => {
  const b = { appearance: { theme: 'Standard', fontSize: 12 }, hotkeys: { 'new-tab': ['Ctrl-T'] } }
  const s = { appearance: { theme: 'Dark', fontSize: 12 }, hotkeys: { 'new-tab': ['Ctrl-N'] } }
  const u = { appearance: { theme: 'Standard', fontSize: 14 }, hotkeys: { 'new-tab': ['Ctrl-Shift-T'] } }
  const r = merge(b, s, u)
  assert.deepEqual(r.cfg.appearance, { theme: 'Dark', fontSize: 14 })
  assert.deepEqual(r.cfg.hotkeys, { 'new-tab': ['Ctrl-Shift-T'] })
  assert.equal(r.changed, true)
})

test('arrays are atomic in settings', () => {
  const b = { list: [1, 2] }
  const r = merge(b, { list: [1, 2, 3] }, { list: [0, 1, 2] })
  assert.deepEqual(r.cfg.list, [0, 1, 2])
})

test('setting removed on device is removed, top-level key added on server is kept', () => {
  const b = { a: 1, b: 2 }
  const r = merge(b, { a: 1, b: 2, c: 3 }, { a: 1 })
  assert.deepEqual(r.cfg, { a: 1, c: 3 })
})

test('base null: upload wins conflicts, server-only profiles kept', () => {
  const s = { appearance: { theme: 'Dark' }, profiles: [p('a', { name: 'srv' }), p('s')] }
  const u = { appearance: { theme: 'Light' }, profiles: [p('a', { name: 'up' }), p('u')] }
  const r = merge(null, s, u)
  assert.equal(r.cfg.appearance.theme, 'Light')
  assert.deepEqual(r.cfg.profiles, [p('a', { name: 'up' }), p('s'), p('u')])
  assert.equal(r.deleted, 0)
})

test('empty server and base: upload stored as is, not changed', () => {
  const u = { profiles: [p('a')], appearance: { theme: 'Dark' } }
  const r = merge(null, null, u)
  assert.deepEqual(r.cfg, u)
  assert.equal(r.changed, false)
  assert.deepEqual(yaml.load(mergeConfig('', '', dump(u)).content), u)
})

test('mass deletion: 6 deletes with maxDeletes 5 rejected, content is server', () => {
  const all = { profiles: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => p(id)) }
  const serverYaml = dump(all)
  const r = mergeConfig(serverYaml, serverYaml, dump({ profiles: [p('a')] }), { maxDeletes: 5 })
  assert.equal(r.rejected, true)
  assert.equal(r.changed, true)
  assert.equal(r.content, serverYaml)
  assert.equal(r.deleted, 6)
})

test('mass deletion: exactly 5 deletes accepted', () => {
  const all = { profiles: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => p(id)) }
  const r = merge(all, all, { profiles: [p('a'), p('b')] }, { maxDeletes: 5 })
  assert.equal(r.rejected, false)
  assert.equal(r.deleted, 5)
  assert.deepEqual(ids(r.cfg), ['a', 'b'])
})

test('default maxDeletes is 5', () => {
  const all = { profiles: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => p(id)) }
  assert.equal(merge(all, all, { profiles: [] }).rejected, true)
})

test('encrypted config: last writer wins', () => {
  const uploadYaml = dump({ encrypted: true, encryptedConfig: 'xyz' })
  const r = mergeConfig(dump({ profiles: [p('a')] }), dump({ profiles: [p('a'), p('b')] }), uploadYaml)
  assert.deepEqual(r, { content: uploadYaml, changed: false, rejected: false, deleted: 0 })
  const r2 = mergeConfig(null, dump({ encrypted: true, encryptedConfig: 'abc' }), dump({ profiles: [] }))
  assert.equal(r2.content, dump({ profiles: [] }))
  assert.equal(r2.changed, false)
})

test('changed is false for identical re-upload of server state', () => {
  const s = { profiles: [p('a'), p('b')], appearance: { theme: 'Dark' } }
  const r = merge({ profiles: [p('a')] }, s, s)
  assert.equal(r.changed, false)
  assert.deepEqual(r.cfg, s)
})

test('changed is false when key order differs only', () => {
  const s = { appearance: { theme: 'Dark', font: 'Mono' }, profiles: [p('a')] }
  const uploadYaml = 'profiles:\n  - type: ssh\n    name: a\n    id: a\nappearance:\n  font: Mono\n  theme: Dark\n'
  assert.equal(mergeConfig(dump(s), dump(s), uploadYaml).changed, false)
})

test('invalid YAML throws', () => {
  const ok = dump({ a: 1 })
  assert.throws(() => mergeConfig(ok, ok, 'a: [1, 2'))
  assert.throws(() => mergeConfig(ok, 'a: : b: {', ok))
  assert.throws(() => mergeConfig(ok, ok, '- just\n- a list\n'))
  assert.throws(() => sameContent('{', ok))
})

test('sameContent ignores key order and formatting', () => {
  assert.equal(sameContent('a: 1\nb:\n  c: [1, 2]\n', 'b: {c: [1,2]}\na: 1'), true)
  assert.equal(sameContent('a: 1', 'a: 2'), false)
  assert.equal(sameContent('list: [1, 2]', 'list: [2, 1]'), false)
  assert.equal(sameContent('', null), true)
  assert.equal(sameContent('', '{}'), true)
})
