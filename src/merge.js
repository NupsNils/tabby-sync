import yaml from 'js-yaml'
import { isDeepStrictEqual as eq } from 'node:util'

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const ID_LISTS = ['profiles', 'groups']
// Paths replaced as a whole, never merged field by field; value = conflict winner.
const ATOMIC = {
  '': 'server', // whole encrypted document
  vault: 'server', // re-encrypted with new salt+iv on every save
  'terminal.colorScheme': 'upload',
  'terminal.lightColorScheme': 'upload',
}

function parse(text) {
  const doc = text == null ? {} : (yaml.load(text) ?? {})
  if (!isObj(doc)) throw new Error('config must be a YAML mapping')
  return doc
}

function merge3(b, s, u, ctx, path) {
  if (eq(u, b)) return s
  if (eq(s, b) || eq(s, u)) return u
  const winner = ATOMIC[path]
  if (winner === 'server') {
    ctx.vaultConflict = true
    return s
  }
  if (!winner && isObj(s) && isObj(u) && (b === undefined || isObj(b))) {
    const base = b ?? {}
    const r = {}
    for (const k of new Set([...Object.keys(s), ...Object.keys(u), ...Object.keys(base)])) {
      const v = merge3(base[k], s[k], u[k], ctx, path ? `${path}.${k}` : k)
      if (v !== undefined) r[k] = v
    }
    return r
  }
  return u
}

const hasIds = l => l === undefined || (Array.isArray(l) && l.every(x => isObj(x) && x.id != null))

function mergeById(b = [], s = [], u = [], ctx, path) {
  const byId = l => new Map(l.map(x => [x.id, x]))
  const B = byId(b), S = byId(s), U = byId(u)
  const list = []
  let deleted = 0
  for (const si of s) {
    if (U.has(si.id)) list.push(merge3(B.get(si.id), si, U.get(si.id), ctx, `${path}[]`))
    else if (B.has(si.id)) deleted++
    else list.push(si)
  }
  for (const ui of u) {
    if (S.has(ui.id)) continue
    if (!B.has(ui.id) || !eq(ui, B.get(ui.id))) list.push(ui)
  }
  return { list, deleted }
}

export function mergeConfig(baseYaml, serverYaml, uploadYaml, { maxDeletes = 5, maxDeletePercent = 50 } = {}) {
  const u = parse(uploadYaml)
  const s = parse(serverYaml)
  const b = parse(baseYaml)
  const noBase = baseYaml == null
  const ctx = { vaultConflict: false }
  const del = { profiles: 0, groups: 0 }
  let result

  if (noBase && !Object.keys(s).length) result = u
  else if (u.encrypted || s.encrypted) result = noBase ? s : merge3(b, s, u, ctx, '')
  else if (noBase) {
    // Unknown device state: keep the server, only add profiles/groups it does not know.
    result = { ...s }
    for (const k of ID_LISTS) {
      if (!Array.isArray(u[k]) || ![s[k], u[k]].every(hasIds)) continue
      const known = new Set((s[k] ?? []).map(x => x.id))
      result[k] = [...(s[k] ?? []), ...u[k].filter(x => !known.has(x.id))]
    }
  } else {
    result = {}
    for (const k of new Set([...Object.keys(s), ...Object.keys(u)])) {
      if (ID_LISTS.includes(k) && [b[k], s[k], u[k]].every(hasIds)) {
        const m = mergeById(b[k], s[k], u[k], ctx, k)
        result[k] = m.list
        del[k] = m.deleted
      } else {
        const v = merge3(b[k], s[k], u[k], ctx, k)
        if (v !== undefined) result[k] = v
      }
    }
  }

  const tooMany = k => del[k] > maxDeletes || (del[k] >= 2 && del[k] * 100 > maxDeletePercent * (s[k]?.length ?? 0))
  const stats = { deleted: del.profiles, deletedGroups: del.groups, vaultConflict: ctx.vaultConflict }
  if (ID_LISTS.some(tooMany)) return { content: serverYaml, changed: true, rejected: true, ...stats }
  return { content: yaml.dump(result), changed: !eq(result, u), rejected: false, ...stats }
}

export function sameContent(yamlA, yamlB) {
  return eq(parse(yamlA), parse(yamlB))
}
