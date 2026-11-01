// 单词模块云函数
//
// 一个函数按 action 分发，入参 { action, ... }，出参和 favoritesApi 保持一致：
//   成功 { success: true, data, message? }
//   失败 { success: false, message }
//
// 涉及五个集合：
//   wordBanks    词库元数据（可选，没数据时小程序用内置词库）
//   wordItems    云端词库（可选，listWords 用）
//   wordProfiles 用户档案（每日目标）
//   wordDaily    每日学习 / 打卡记录，一天一条
//   wordRecords  单词级作答记录，一个词一条，取词时按 seen 升序跳过背过的
//
// 所有用户维度的文档 ID 都由 openid 派生，既保证一个用户一份，
// 也避免客户端传 openid 冒充别人。

const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

/* ---------------- 常量 ---------------- */

const GOAL_DEFAULT = 10
const GOAL_MIN = 1
const GOAL_MAX = 100

// 一天最多算多少词，超过基本是脏数据或者在刷接口
const DAY_LEARNED_MAX = 2000
// 单个词最多被记录多少次
const WORD_SEEN_MAX = 999

// 单次请求的返回条数上限，云函数返回体上限 1MB
const DAILY_LIMIT_MAX = 180
const WORD_LIMIT_DEFAULT = 300
const WORD_LIMIT_MAX = 500
const HISTORY_LIMIT_MAX = 60
const BANK_LIMIT_MAX = 20
const CALENDAR_DAYS = 31

// 一次同步最多带多少条，超了让客户端分批传
const SYNC_ITEM_MAX = 400
// 写库并发，太高会触发数据库限流
const WRITE_CONCURRENCY = 10
// 云函数里单次 get 最多 1000 条
const PAGE_SIZE = 1000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BANK_RE = /^[a-z0-9]{2,16}$/
// 词库里最长的单词 16 个字符，允许空格、连字符、撇号、句点
const WORD_RE = /^[a-zA-Z][a-zA-Z .'-]{0,31}$/

const COLL = {
  banks: 'wordBanks',
  items: 'wordItems',
  profiles: 'wordProfiles',
  daily: 'wordDaily',
  records: 'wordRecords'
}

/* ---------------- 基础工具 ---------------- */

// 云函数默认跑在 UTC，直接用 new Date() 会让北京时间 0-8 点的打卡
// 算到前一天，所以统一加 8 小时再取日期
const TIMEZONE_OFFSET = 8 * 60 * 60 * 1000

function todayKey() {
  return new Date(Date.now() + TIMEZONE_OFFSET).toISOString().slice(0, 10)
}

function shiftKey(key, days) {
  const parts = key.split('-')
  const date = new Date(Date.UTC(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2])
  ))

  date.setUTCDate(date.getUTCDate() + days)

  return date.toISOString().slice(0, 10)
}

function monthRange(year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()

  return {
    from: `${prefix}-01`,
    to: `${prefix}-${String(lastDay).padStart(2, '0')}`,
    lastDay: lastDay
  }
}

// 用户维度的文档 ID 一律由 openid 派生，不让客户端决定
function docId(prefix, parts) {
  const hash = crypto
    .createHash('sha256')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 32)

  return prefix + hash
}

function toInt(value, min, max, fallback) {
  const number = Math.round(Number(value))

  if (!Number.isFinite(number)) return fallback
  if (number < min) return min
  if (number > max) return max

  return number
}

function clampGoal(value) {
  const number = Math.round(Number(value))

  if (!Number.isFinite(number) || number < GOAL_MIN) return GOAL_DEFAULT
  if (number > GOAL_MAX) return GOAL_MAX

  return number
}

function chunk(list, size) {
  const result = []

  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size))
  }

  return result
}

// 限流版的 Promise.all，避免一次打太多写请求把数据库打到限流
async function mapLimit(list, limit, worker) {
  const results = []
  let cursor = 0

  async function run() {
    while (cursor < list.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(list[index], index)
    }
  }

  const runners = []
  const count = Math.min(limit, list.length)

  for (let i = 0; i < count; i += 1) {
    runners.push(run())
  }

  await Promise.all(runners)

  return results
}

/* ---------------- 数据整形 ---------------- */

function normalizeDay(input) {
  if (!input || typeof input !== 'object') return null

  const dateKey = String(input.dateKey || '')

  if (!DATE_RE.test(dateKey)) return null

  const learned = toInt(input.learned, 0, DAY_LEARNED_MAX, 0)
  const total = Math.max(learned, toInt(input.total, 0, DAY_LEARNED_MAX, learned))
  // 正确数不可能比作答数还多
  const correct = Math.min(toInt(input.correct, 0, DAY_LEARNED_MAX, 0), total)

  return {
    dateKey: dateKey,
    learned: learned,
    correct: correct,
    total: total
  }
}

function normalizeWord(input) {
  if (!input || typeof input !== 'object') return null

  const bankId = String(input.bankId || '')
  const wordId = String(input.wordId || '')

  if (!BANK_RE.test(bankId) || !WORD_RE.test(wordId)) return null

  const seen = toInt(input.seen, 0, WORD_SEEN_MAX, 0)

  return {
    bankId: bankId,
    wordId: wordId,
    seen: seen,
    correct: Math.min(toInt(input.correct, 0, WORD_SEEN_MAX, 0), seen)
  }
}

// 对外只暴露这几个字段，库里的 userOpenId / updatedAt 不返回
function formatDay(item, goal) {
  const learned = item.learned || 0
  const total = item.total || 0

  return {
    dateKey: item.dateKey,
    learned: learned,
    correct: item.correct || 0,
    total: total,
    accuracy: total > 0 ? Math.round(((item.correct || 0) / total) * 100) : 0,
    checked: learned >= goal
  }
}

/* ---------------- 读库 ---------------- */

async function readProfile(openid) {
  const id = docId('wp_', [openid])

  try {
    const result = await db.collection(COLL.profiles).doc(id).get()

    return result.data || null
  } catch (error) {
    // 文档不存在时 doc().get() 会抛错，这里当成新用户
    return null
  }
}

async function currentGoal(openid) {
  const profile = await readProfile(openid)

  return profile ? clampGoal(profile.goal) : GOAL_DEFAULT
}

async function writeGoal(openid, goal) {
  const id = docId('wp_', [openid])
  const profile = await readProfile(openid)
  const data = {
    userOpenId: openid,
    goal: goal,
    updatedAt: db.serverDate()
  }

  // set 会整条覆盖，创建时间要自己带上
  data.createdAt = profile && profile.createdAt ? profile.createdAt : db.serverDate()

  await db.collection(COLL.profiles).doc(id).set({ data: data })

  return goal
}

// 取某个时间点之后的每日记录，日期升序
async function fetchDaily(openid, fromKey, toKey) {
  const where = {
    userOpenId: openid,
    dateKey: _.and(_.gte(fromKey), _.lte(toKey))
  }

  const result = await db.collection(COLL.daily)
    .where(where)
    .orderBy('dateKey', 'asc')
    .limit(DAILY_LIMIT_MAX)
    .get()

  return result.data
}

// 取用户全部的每日记录，用于累计统计
async function fetchAllDaily(openid) {
  const collection = db.collection(COLL.daily)
  const countResult = await collection.where({ userOpenId: openid }).count()
  const total = countResult.total || 0

  if (!total) return []

  const pages = Math.ceil(total / PAGE_SIZE)
  const tasks = []

  for (let i = 0; i < pages; i += 1) {
    tasks.push(
      collection
        .where({ userOpenId: openid })
        .orderBy('dateKey', 'asc')
        .skip(i * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .get()
    )
  }

  const results = await Promise.all(tasks)
  const list = []

  results.forEach(result => {
    result.data.forEach(item => list.push(item))
  })

  return list
}

async function fetchWords(openid, offset, limit) {
  if (limit <= 0) return []

  const result = await db.collection(COLL.records)
    .where({ userOpenId: openid })
    .orderBy('updatedAt', 'desc')
    .skip(offset)
    .limit(limit)
    .get()

  return result.data
}

function computeStreak(dayMap, goal) {
  let cursor = todayKey()
  let streak = 0
  // 兜底上限，防止脏数据把循环拖死
  let guard = 0

  if (!isChecked(dayMap[cursor], goal)) {
    cursor = shiftKey(cursor, -1)
  }

  while (isChecked(dayMap[cursor], goal) && guard < 3650) {
    streak += 1
    guard += 1
    cursor = shiftKey(cursor, -1)
  }

  return streak
}

function isChecked(day, goal) {
  return !!day && (day.learned || 0) >= goal
}

/* ---------------- 写库（合并） ---------------- */

// 每日记录按 max 合并，重复上传不会把数字放大，客户端可以放心重试
async function mergeDaily(openid, items, goal) {
  if (!items.length) return 0

  const collection = db.collection(COLL.daily)
  let written = 0

  for (const group of chunk(items, 50)) {
    const keys = group.map(item => item.dateKey)
    const existing = await collection
      .where({ userOpenId: openid, dateKey: _.in(keys) })
      .limit(keys.length)
      .get()

    const map = new Map(existing.data.map(doc => [doc.dateKey, doc]))

    await mapLimit(group, WRITE_CONCURRENCY, async item => {
      const prev = map.get(item.dateKey) || {}
      const learned = Math.max(prev.learned || 0, item.learned)
      const correct = Math.max(prev.correct || 0, item.correct)
      const total = Math.max(prev.total || 0, item.total)

      // 一条记录都没有的日期不值得存，免得库里堆一堆空文档
      if (!prev.dateKey && learned === 0 && correct === 0 && total === 0) {
        return
      }

      if (
        prev.dateKey &&
        learned === (prev.learned || 0) &&
        correct === (prev.correct || 0) &&
        total === (prev.total || 0)
      ) {
        return
      }

      await collection.doc(docId('wd_', [openid, item.dateKey])).set({
        data: {
          userOpenId: openid,
          dateKey: item.dateKey,
          learned: learned,
          correct: correct,
          total: total,
          // 记一下写入时的目标，方便事后核对，判定打卡还是按当前目标算
          goal: goal,
          updatedAt: db.serverDate()
        }
      })

      written += 1
    })
  }

  return written
}

async function mergeWords(openid, items) {
  if (!items.length) return 0

  const collection = db.collection(COLL.records)
  let written = 0

  for (const group of chunk(items, 50)) {
    const ids = group.map(item => docId('wr_', [openid, item.bankId, item.wordId]))
    const existing = await collection.where({ _id: _.in(ids) }).limit(ids.length).get()
    const map = new Map(existing.data.map(doc => [doc._id, doc]))

    await mapLimit(group, WRITE_CONCURRENCY, async (item, index) => {
      const id = ids[index]
      const prev = map.get(id) || {}
      const seen = Math.max(prev.seen || 0, item.seen)
      const correct = Math.max(prev.correct || 0, item.correct)

      if (prev._id && seen === (prev.seen || 0) && correct === (prev.correct || 0)) {
        return
      }

      await collection.doc(id).set({
        data: {
          userOpenId: openid,
          bankId: item.bankId,
          wordId: item.wordId,
          seen: seen,
          correct: correct,
          updatedAt: db.serverDate()
        }
      })

      written += 1
    })
  }

  return written
}

/* ---------------- action ---------------- */

// 词库列表。集合没初始化时返回空数组，小程序会退回内置词库。
async function listBanks() {
  let list = []

  try {
    const result = await db.collection(COLL.banks)
      .orderBy('order', 'asc')
      .limit(BANK_LIMIT_MAX)
      .get()

    list = result.data
  } catch (error) {
    console.warn('wordBanks 集合不可用：', error)
  }

  return {
    success: true,
    data: list.map(bank => ({
      id: bank.bankId || bank.id,
      name: bank.name,
      desc: bank.desc || '',
      total: bank.total || 0
    }))
  }
}

// 云端词库分页取词。小程序平时读内置词库，这里留给多端或后台改词用。
async function listWords(openid, event) {
  const bankId = String(event.bankId || '')

  if (!BANK_RE.test(bankId)) {
    return { success: false, message: '词库参数不正确' }
  }

  const limit = toInt(event.limit, 1, WORD_LIMIT_MAX, WORD_LIMIT_DEFAULT)
  const offset = toInt(event.offset, 0, 200000, 0)
  const collection = db.collection(COLL.items)

  let total = 0
  let data = []

  try {
    const countResult = await collection.where({ bankId: bankId }).count()

    total = countResult.total || 0

    if (total) {
      const result = await collection
        .where({ bankId: bankId })
        .orderBy('order', 'asc')
        .skip(offset)
        .limit(limit)
        .get()

      data = result.data
    }
  } catch (error) {
    console.warn('wordItems 集合不可用：', error)
  }

  return {
    success: true,
    data: data.map(item => ({
      id: item.word,
      word: item.word,
      phoneticUk: item.phoneticUk || '',
      phoneticUs: item.phoneticUs || '',
      meaning: item.meaning || '',
      example: item.example || '',
      exampleCn: item.exampleCn || ''
    })),
    total: total,
    offset: offset
  }
}

// 拉取进度快照：每日目标 + 最近若干天的每日记录 + 一页单词记录
async function getProgress(openid, event) {
  const profile = await readProfile(openid)
  const goal = profile ? clampGoal(profile.goal) : GOAL_DEFAULT
  const today = todayKey()
  const from = shiftKey(today, -(DAILY_LIMIT_MAX - 1))
  const wordLimit = toInt(event.wordLimit, 0, WORD_LIMIT_MAX, WORD_LIMIT_DEFAULT)
  const wordOffset = toInt(event.wordOffset, 0, 200000, 0)

  const daily = await fetchDaily(openid, from, today)
  const words = await fetchWords(openid, wordOffset, wordLimit)

  return {
    success: true,
    data: {
      goal: goal,
      today: today,
      daily: daily.map(item => ({
        dateKey: item.dateKey,
        learned: item.learned || 0,
        correct: item.correct || 0,
        total: item.total || 0
      })),
      words: words.map(item => ({
        bankId: item.bankId,
        wordId: item.wordId,
        seen: item.seen || 0,
        correct: item.correct || 0
      })),
      wordOffset: wordOffset,
      wordLimit: wordLimit,
      updatedAt: profile ? profile.updatedAt : null
    }
  }
}

// 上行合并。不传 goal 就不动目标，方便只同步作答记录的场景。
async function saveProgress(openid, event) {
  const dailyItems = Array.isArray(event.daily)
    ? event.daily.map(normalizeDay).filter(Boolean)
    : []
  const wordItems = Array.isArray(event.words)
    ? event.words.map(normalizeWord).filter(Boolean)
    : []

  if (dailyItems.length > SYNC_ITEM_MAX || wordItems.length > SYNC_ITEM_MAX) {
    return { success: false, message: '本次同步数据过多，请分批上传' }
  }

  const hasGoal = event.goal !== undefined && event.goal !== null
  const goal = hasGoal ? clampGoal(event.goal) : await currentGoal(openid)

  if (hasGoal) {
    await writeGoal(openid, goal)
  }

  const dailyWritten = await mergeDaily(openid, dailyItems, goal)
  const wordWritten = await mergeWords(openid, wordItems)

  return {
    success: true,
    data: {
      goal: goal,
      dailyWritten: dailyWritten,
      wordWritten: wordWritten
    }
  }
}

async function getGoal(openid) {
  return {
    success: true,
    data: { goal: await currentGoal(openid) }
  }
}

async function setGoal(openid, event) {
  const raw = Math.round(Number(event.goal))

  if (!Number.isFinite(raw)) {
    return { success: false, message: '每日目标格式不正确' }
  }

  const goal = clampGoal(raw)

  await writeGoal(openid, goal)

  return {
    success: true,
    data: { goal: goal },
    message: `每日目标已设为 ${goal} 词`
  }
}

// 学习记录：按日期倒序，只取有作答的那些天
async function getHistory(openid, event) {
  const limit = toInt(event.limit, 1, HISTORY_LIMIT_MAX, 7)
  const goal = await currentGoal(openid)

  const result = await db.collection(COLL.daily)
    .where({ userOpenId: openid, learned: _.gt(0) })
    .orderBy('dateKey', 'desc')
    .limit(limit)
    .get()

  return {
    success: true,
    data: result.data.map(item => formatDay(item, goal))
  }
}

// 打卡记录：某个月的日历，缺的天补 0
async function getCalendar(openid, event) {
  // 越界直接拒绝，不能悄悄夹成 12 月，否则用户看到的是别的月份
  const year = Math.round(Number(event.year))
  const month = Math.round(Number(event.month))

  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return { success: false, message: '年份参数不正确' }
  }

  if (!Number.isFinite(month) || month < 1 || month > 12) {
    return { success: false, message: '月份参数不正确' }
  }

  const goal = await currentGoal(openid)
  const range = monthRange(year, month)
  const today = todayKey()

  const result = await db.collection(COLL.daily)
    .where({
      userOpenId: openid,
      dateKey: _.and(_.gte(range.from), _.lte(range.to))
    })
    .limit(CALENDAR_DAYS)
    .get()

  const map = {}

  result.data.forEach(item => {
    map[item.dateKey] = item
  })

  const prefix = range.from.slice(0, 7)
  const days = []

  for (let day = 1; day <= range.lastDay; day += 1) {
    const key = `${prefix}-${String(day).padStart(2, '0')}`
    const record = map[key]

    days.push({
      dateKey: key,
      day: day,
      learned: record ? record.learned || 0 : 0,
      checked: isChecked(record, goal),
      isToday: key === today
    })
  }

  return {
    success: true,
    data: {
      year: year,
      month: month,
      goal: goal,
      days: days
    }
  }
}

// 汇总统计：累计天数 / 词数 / 正确率 / 连续打卡
async function getStats(openid) {
  const goal = await currentGoal(openid)
  const all = await fetchAllDaily(openid)

  const dayMap = {}
  let days = 0
  let learned = 0
  let correct = 0
  let total = 0

  all.forEach(item => {
    dayMap[item.dateKey] = item

    const count = item.learned || 0

    if (!count) return

    days += 1
    learned += count
    correct += item.correct || 0
    total += item.total || 0
  })

  const today = todayKey()

  return {
    success: true,
    data: {
      goal: goal,
      days: days,
      learned: learned,
      correct: correct,
      total: total,
      accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
      streak: computeStreak(dayMap, goal),
      today: formatDay(dayMap[today] || { dateKey: today }, goal)
    }
  }
}

// 清空云端进度，配合「清空演示数据」用
async function resetProgress(openid) {
  let removed = 0

  for (const name of [COLL.daily, COLL.records]) {
    const collection = db.collection(name)

    // 云函数里一次最多删 1000 条，循环到删干净为止
    for (let i = 0; i < 20; i += 1) {
      const result = await collection.where({ userOpenId: openid }).remove()
      const count = (result.stats && result.stats.removed) || 0

      removed += count

      if (count < PAGE_SIZE) break
    }
  }

  return {
    success: true,
    data: { removed: removed },
    message: '已清空云端学习记录'
  }
}

const HANDLERS = {
  listBanks: listBanks,
  listWords: listWords,
  getProgress: getProgress,
  saveProgress: saveProgress,
  getGoal: getGoal,
  setGoal: setGoal,
  getHistory: getHistory,
  getCalendar: getCalendar,
  getStats: getStats,
  resetProgress: resetProgress
}

exports.main = async (event, context) => {
  const payload = event || {}
  const action = payload.action

  try {
    // 身份只认微信上下文，不接受客户端传的 openid
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID

    if (!openid) {
      return { success: false, message: '无法确认用户身份' }
    }

    const handler = HANDLERS[action]

    if (!handler) {
      return { success: false, message: '不支持的操作' }
    }

    return await handler(openid, payload)
  } catch (error) {
    console.error('单词云函数错误：', action, error)

    return { success: false, message: '操作失败，请稍后重试' }
  }
}
