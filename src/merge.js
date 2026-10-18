import yaml from 'js-yaml'
import { isDeepStrictEqual as eq } from 'node:util'

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const ID_LISTS = ['profiles', 'groups']

function parse(text) {
  const doc = text == null ? {} : (yaml.load(text) ?? {})
  if (!isObj(doc)) throw new Error('config must be a YAML mapping')
  return doc
}

function merge3(b, s, u) {
  if (eq(u, b)) return s
  if (eq(s, b)) return u
  if (isObj(s) && isObj(u) && (b === undefined || isObj(b))) {
    const base = b ?? {}
    const r = {}
    for (const k of new Set([...Object.keys(s), ...Object.keys(u), ...Object.keys(base)])) {
      const v = merge3(base[k], s[k], u[k])
      if (v !== undefined) r[k] = v
    }
    return r
  }
  return u
}

const hasIds = l => l === undefined || (Array.isArray(l) && l.every(x => isObj(x) && x.id != null))

function mergeById(b = [], s = [], u = []) {
  const byId = l => new Map(l.map(x => [x.id, x]))
  const B = byId(b), S = byId(s), U = byId(u)
  const list = []
  let deleted = 0
  for (const si of s) {
    if (U.has(si.id)) list.push(merge3(B.get(si.id), si, U.get(si.id)))
    else if (B.has(si.id)) deleted++
    else list.push(si)
  }
  for (const ui of u) {
    if (S.has(ui.id)) continue
    if (!B.has(ui.id) || !eq(ui, B.get(ui.id))) list.push(ui)
  }
  return { list, deleted }
}

export function mergeConfig(baseYaml, serverYaml, uploadYaml, { maxDeletes = 5 } = {}) {
  const u = parse(uploadYaml)
  const s = parse(serverYaml)
  const b = parse(baseYaml)
  if (u.encrypted || s.encrypted) return { content: uploadYaml, changed: false, rejected: false, deleted: 0 }

  const result = {}
  let deleted = 0
  for (const k of new Set([...Object.keys(s), ...Object.keys(u)])) {
    if (ID_LISTS.includes(k) && [b[k], s[k], u[k]].every(hasIds)) {
      const m = mergeById(b[k], s[k], u[k])
      result[k] = m.list
      if (k === 'profiles') deleted = m.deleted
    } else {
      const v = merge3(b[k], s[k], u[k])
      if (v !== undefined) result[k] = v
    }
  }

  if (deleted > maxDeletes) return { content: serverYaml, changed: true, rejected: true, deleted }
  return { content: yaml.dump(result), changed: !eq(result, u), rejected: false, deleted }
}

export function sameContent(yamlA, yamlB) {
  return eq(parse(yamlA), parse(yamlB))
}
