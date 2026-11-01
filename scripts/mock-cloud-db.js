// 内存版 wx-server-sdk，给 scripts 下的测试用。
// 只实现 wordsApi 用到的那部分：collection / where / orderBy / skip / limit /
// get / count / remove / doc().get / doc().set，以及 db.command 的几个操作符。

const path = require('path')
const Module = require('module')

const COLLECTIONS = new Map()

function coll(name) {
  if (!COLLECTIONS.has(name)) COLLECTIONS.set(name, new Map())
  return COLLECTIONS.get(name)
}

const command = {
  and: (...items) => ({ $op: 'and', items }),
  gte: value => ({ $op: 'gte', value }),
  lte: value => ({ $op: 'lte', value }),
  gt: value => ({ $op: 'gt', value }),
  lt: value => ({ $op: 'lt', value }),
  in: values => ({ $op: 'in', values })
}

function matchValue(actual, cond) {
  if (cond && cond.$op) {
    switch (cond.$op) {
      case 'and': return cond.items.every(item => matchValue(actual, item))
      case 'gte': return actual >= cond.value
      case 'lte': return actual <= cond.value
      case 'gt': return actual > cond.value
      case 'lt': return actual < cond.value
      case 'in': return cond.values.includes(actual)
      default: throw new Error('未知操作符 ' + cond.$op)
    }
  }
  return actual === cond
}

function matchDoc(doc, where) {
  return Object.keys(where).every(key => matchValue(doc[key], where[key]))
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

class Query {
  constructor(name) {
    this.name = name
    this.cond = {}
    this.order = null
    this.skipN = 0
    this.limitN = 100
  }
  where(obj) { Object.assign(this.cond, obj); return this }
  orderBy(field, dir) { this.order = { field, dir }; return this }
  skip(n) { this.skipN = n; return this }
  limit(n) { this.limitN = n; return this }

  rows() {
    const list = [...coll(this.name).values()].filter(doc => matchDoc(doc, this.cond))

    if (this.order) {
      const { field, dir } = this.order
      list.sort((a, b) => {
        if (a[field] === b[field]) return 0
        return (a[field] > b[field] ? 1 : -1) * (dir === 'desc' ? -1 : 1)
      })
    }

    return list
  }

  async get() {
    if (this.limitN > 1000) throw new Error('limit 超过 1000')
    return { data: clone(this.rows().slice(this.skipN, this.skipN + this.limitN)) }
  }
  async count() { return { total: this.rows().length } }
  async remove() {
    const rows = this.rows().slice(0, 1000)
    rows.forEach(doc => coll(this.name).delete(doc._id))
    return { stats: { removed: rows.length } }
  }
}

class DocRef {
  constructor(name, id) { this.name = name; this.id = id }
  async get() {
    const doc = coll(this.name).get(this.id)
    if (!doc) throw new Error('document does not exist')
    return { data: clone(doc) }
  }
  async set({ data }) {
    coll(this.name).set(this.id, clone(Object.assign({ _id: this.id }, data)))
    return { stats: { updated: 1 } }
  }
  async remove() {
    const had = coll(this.name).delete(this.id)
    return { stats: { removed: had ? 1 : 0 } }
  }
}

const db = {
  collection: name => Object.assign(new Query(name), { doc: id => new DocRef(name, id) }),
  command: command,
  serverDate: () => new Date()
}

let currentOpenid = 'openid_test_user'

const sdk = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: currentOpenid })
}

// 用假模块顶掉 wx-server-sdk，测试就能直接 require 云函数
const originalResolve = Module._resolveFilename

Module._resolveFilename = function (request, ...rest) {
  if (request === 'wx-server-sdk') return 'wx-server-sdk'
  return originalResolve.call(this, request, ...rest)
}

require.cache['wx-server-sdk'] = {
  id: 'wx-server-sdk',
  filename: 'wx-server-sdk',
  loaded: true,
  exports: sdk
}

function createServer() {
  const api = require(path.join(__dirname, '..', 'cloudfunctions/wordsApi/index.js'))

  return {
    main: (event, context) => api.main(event, context),
    setOpenid: openid => { currentOpenid = openid },
    reset: () => COLLECTIONS.clear()
  }
}

module.exports = { createServer }
