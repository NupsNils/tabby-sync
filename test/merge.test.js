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
  assert.equal(r.deletedGroups, 1)
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

test('base null: server wins, only unknown profiles appended', () => {
  const s = { appearance: { theme: 'Dark' }, profiles: [p('a', { name: 'srv' }), p('s')] }
  const u = { appearance: { theme: 'Light' }, profiles: [p('a', { name: 'up' }), p('u')] }
  const r = merge(null, s, u)
  assert.equal(r.cfg.appearance.theme, 'Dark')
  assert.deepEqual(r.cfg.profiles, [p('a', { name: 'srv' }), p('s'), p('u')])
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

const many = n => Array.from({ length: n }, (_, i) => p(`p${i}`))

test('mass deletion: exactly 5 deletes accepted', () => {
  const all = { profiles: many(12) }
  const r = merge(all, all, { profiles: all.profiles.slice(0, 7) }, { maxDeletes: 5 })
  assert.equal(r.rejected, false)
  assert.equal(r.deleted, 5)
  assert.equal(r.cfg.profiles.length, 7)
})

test('default maxDeletes is 5', () => {
  const all = { profiles: many(14) }
  const r = merge(all, all, { profiles: all.profiles.slice(0, 8) })
  assert.equal(r.rejected, true)
  assert.equal(r.deleted, 6)
})

test('percent rule: profiles', () => {
  const four = { profiles: many(4) }
  assert.equal(merge(four, four, { profiles: many(2) }).rejected, false)
  assert.equal(merge(four, four, { profiles: many(1) }).rejected, true)
  const two = { profiles: many(2) }
  assert.equal(merge(two, two, { profiles: many(1) }).rejected, false)
  const ten = { profiles: many(10) }
  const r = merge(ten, ten, { profiles: many(4) }, { maxDeletePercent: 100 })
  assert.equal(r.rejected, true)
  assert.equal(r.deleted, 6)
  assert.equal(merge(four, four, { profiles: many(1) }, { maxDeletePercent: 75 }).rejected, false)
  assert.equal(merge(four, four, { profiles: many(2) }, { maxDeletePercent: 40 }).rejected, true)
})

test('percent rule: groups counted separately', () => {
  const g = id => ({ id, name: id })
  const three = { groups: [g('g1'), g('g2'), g('g3')], profiles: many(3) }
  const r = merge(three, three, { groups: [g('g1')], profiles: many(3) })
  assert.equal(r.rejected, true)
  assert.equal(r.deletedGroups, 2)
  assert.equal(r.deleted, 0)
  assert.equal(merge(three, three, { groups: [g('g1'), g('g2')], profiles: many(3) }).rejected, false)
})

test('encrypted config: whole document atomic, server wins conflicts', () => {
  const enc = c => ({ encrypted: true, encryptedConfig: c })
  const both = merge(enc('base'), enc('srv'), enc('up'))
  assert.deepEqual(both.cfg, enc('srv'))
  assert.equal(both.vaultConflict, true)
  assert.equal(both.changed, true)
  const onlyUp = merge(enc('base'), enc('base'), enc('up'))
  assert.deepEqual(onlyUp.cfg, enc('up'))
  assert.equal(onlyUp.vaultConflict, false)
  assert.equal(onlyUp.changed, false)
  assert.deepEqual(merge(enc('base'), enc('srv'), { profiles: [p('a')] }).cfg, enc('srv'))
  const noBase = merge(null, enc('srv'), enc('up'))
  assert.deepEqual(noBase.cfg, enc('srv'))
  assert.equal(noBase.changed, true)
  assert.deepEqual(merge(null, {}, enc('up')).cfg, enc('up'))
})

const vault = (contents, keySalt, iv) => ({ version: 1, contents, keySalt, iv })

test('REGRESSION Critical 1: vault is atomic, server wins on conflict', () => {
  const b = { vault: vault('c0', 's0', 'i0') }
  const s = { vault: vault('cA', 's0', 'iA') }
  const u = { vault: vault('cB', 'sB', 'iB') }
  const r = merge(b, s, u)
  assert.deepEqual(r.cfg.vault, s.vault)
  assert.equal(r.vaultConflict, true)
  assert.equal(r.changed, true)
  // a field-wise merge would mix the server keySalt with upload contents/iv here
  const s2 = { vault: vault('cA', 'sA', 'iA') }
  const u2 = { vault: vault('cB', 's0', 'iB') }
  assert.deepEqual(merge(b, s2, u2).cfg.vault, s2.vault)
})

test('vault changed on one side only: that side complete, no conflict', () => {
  const b = { vault: vault('c0', 's0', 'i0'), a: 1 }
  const v = { vault: vault('cX', 'sX', 'iX'), a: 1 }
  const up = merge(b, b, v)
  assert.deepEqual(up.cfg.vault, v.vault)
  assert.equal(up.vaultConflict, false)
  const srv = merge(b, v, b)
  assert.deepEqual(srv.cfg.vault, v.vault)
  assert.equal(srv.vaultConflict, false)
})

test('identical vault change on both sides is no conflict', () => {
  const b = { vault: vault('c0', 's0', 'i0') }
  const v = { vault: vault('cX', 'sX', 'iX') }
  const r = merge(b, v, v)
  assert.deepEqual(r.cfg.vault, v.vault)
  assert.equal(r.vaultConflict, false)
  assert.equal(r.changed, false)
})

test('colorScheme is atomic: upload wins whole scheme on conflict', () => {
  const scheme = (fg, bg) => ({ name: 'x', foreground: fg, background: bg })
  const b = { terminal: { colorScheme: scheme('f0', 'b0'), lightColorScheme: scheme('f0', 'b0'), fontSize: 12 } }
  const s = { terminal: { colorScheme: scheme('fS', 'b0'), lightColorScheme: scheme('f0', 'bS'), fontSize: 14 } }
  const u = { terminal: { colorScheme: scheme('f0', 'bU'), lightColorScheme: scheme('fU', 'b0'), fontSize: 12 } }
  const r = merge(b, s, u)
  assert.deepEqual(r.cfg.terminal, { colorScheme: scheme('f0', 'bU'), lightColorScheme: scheme('fU', 'b0'), fontSize: 14 })
  assert.equal(r.vaultConflict, false)
})

test('REGRESSION Critical 2: fresh device does not overwrite server state', () => {
  const g = id => ({ id, name: id })
  const s = {
    vault: vault('cS', 'sS', 'iS'),
    appearance: { theme: 'Standard' },
    terminal: { fontSize: 14 },
    profiles: [p('P1'), p('P2')],
    groups: [g('G1')],
  }
  const u = {
    vault: vault('cD', 'sD', 'iD'),
    appearance: { theme: 'Dracula' },
    terminal: { fontSize: 18 },
    profiles: [p('P1', { name: 'mine' }), p('P3')],
    groups: [g('G2')],
  }
  const r = merge(null, s, u)
  assert.deepEqual(r.cfg, { ...s, profiles: [p('P1'), p('P2'), p('P3')], groups: [g('G1'), g('G2')] })
  assert.equal(r.deleted, 0)
  assert.equal(r.deletedGroups, 0)
  assert.equal(r.changed, true)
})

test('base null and empty server: upload taken completely', () => {
  const u = { vault: vault('c', 's', 'i'), profiles: [p('a')], appearance: { theme: 'Dark' } }
  const r = merge(null, {}, u)
  assert.deepEqual(r.cfg, u)
  assert.equal(r.changed, false)
})

test('base {} is a real base: normal 3-way merge', () => {
  const r = mergeConfig('{}', dump({ appearance: { theme: 'Dark' } }), dump({ appearance: { theme: 'Light' } }))
  assert.equal(yaml.load(r.content).appearance.theme, 'Light')
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
