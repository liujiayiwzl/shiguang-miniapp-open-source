// 背单词进度与统计（主包）
// 只负责本地进度存储、统计与打卡判定。
// 词库数据在分包 packageWords 里，因为全量词库约 1.5MB，主包放不下。
// 主包不能 require 分包文件，所以两边拆开：这里给「我的」页和分包页共用。
//
// 云端同步是「本地优先」的：作答先写本地，攒一批增量再补传，
// 云端挂了也不影响任何功能，只是换手机接不上进度。

const cloud = require('./word-cloud')

// 云端同步开关。关掉就退回纯本地，功能和以前完全一样。
const CLOUD_ENABLED = true

// 每日目标词数：默认 10，用户可以在打卡页自己调
const DEFAULT_GOAL = 10
// 目标允许范围，太小没有意义，太大一天背不完
const GOAL_MIN = 1
const GOAL_MAX = 100

// 本地进度存储的 key，带版本号方便以后迁移
const STORAGE_KEY = 'shiguang_words_progress_v1'

// 攒够这么久就把增量传一次，避免每背一个词都发一次请求
const FLUSH_DELAY = 10000
// 两次同步之间至少隔这么久，防止来回切页面反复拉数据
const SYNC_MIN_INTERVAL = 5000


/* ---------------- 工具函数 ---------------- */

function pad2(value) {
  return String(value).padStart(2, '0')
}

// 统一成 YYYY-MM-DD，便于做 key 和比较
function dateKey(date) {
  const target = date || new Date()

  return `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`
}

function todayKey() {
  return dateKey(new Date())
}

// 往前/往后推几天
function shiftDate(date, days) {
  const next = new Date(date.getTime())

  next.setDate(next.getDate() + days)

  return next
}

// 洗牌，用于打乱选项顺序
function shuffle(list) {
  const result = list.slice()

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = result[i]

    result[i] = result[j]
    result[j] = temp
  }

  return result
}

// 四选一：正确释义 + 3 个同词库的其他释义
function buildOptions(word, pool) {
  if (!word) return []

  const others = (pool || [])
    .filter(item => item.id !== word.id && item.meaning && item.meaning !== word.meaning)
    .map(item => item.meaning)

  const distractors = shuffle(others).slice(0, 3)
  const options = shuffle([word.meaning].concat(distractors))

  return options.map((meaning, index) => ({
    key: `${word.id}_${index}`,
    meaning: meaning,
    correct: meaning === word.meaning
  }))
}


/* ---------------- 本地学习进度 ---------------- */

// 待同步的增量：值存的是「当天的累计值」而不是差值，
// 因为云端按 max 合并，同一份数据传几次结果都一样。
function emptyPending() {
  return { daily: {}, words: {}, goal: null }
}

function readStore() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY)

    if (!value || typeof value !== 'object') {
      return { daily: {}, words: {}, goal: DEFAULT_GOAL, pending: emptyPending() }
    }

    const pending = value.pending && typeof value.pending === 'object' ? value.pending : {}
    const pendingGoal = Number(pending.goal)

    return {
      daily: value.daily && typeof value.daily === 'object' ? value.daily : {},
      words: value.words && typeof value.words === 'object' ? value.words : {},
      goal: normalizeGoal(value.goal),
      pending: {
        daily: pending.daily && typeof pending.daily === 'object' ? pending.daily : {},
        words: pending.words && typeof pending.words === 'object' ? pending.words : {},
        goal: pendingGoal > 0 ? normalizeGoal(pendingGoal) : null
      }
    }
  } catch (error) {
    console.warn('读取学习进度失败：', error)

    return { daily: {}, words: {}, goal: DEFAULT_GOAL, pending: emptyPending() }
  }
}

// 目标值统一在这里夹到合法范围，避免脏数据把进度条算成负数或几千
function normalizeGoal(value) {
  const number = Math.round(Number(value))

  if (!number || number < GOAL_MIN) return DEFAULT_GOAL
  if (number > GOAL_MAX) return GOAL_MAX

  return number
}

function writeStore(store) {
  try {
    wx.setStorageSync(STORAGE_KEY, store)
  } catch (error) {
    console.warn('保存学习进度失败：', error)
  }
}

// 当前每日目标
function getGoal() {
  return readStore().goal
}

// 改每日目标，返回最终生效的值
function setGoal(value) {
  const store = readStore()

  store.goal = normalizeGoal(value)
  // 目标很小，立刻传一次；传不上去也没关系，下次同步会带上
  store.pending.goal = store.goal
  writeStore(store)
  flushPending()

  return store.goal
}

// 记一次作答：翻卡的「认识/不认识」和四选一都走这里
function recordAnswer(params) {
  const bankId = (params && params.bankId) || ''
  const wordId = (params && params.wordId) || ''
  const correct = !!(params && params.correct)
  const store = readStore()
  const key = todayKey()
  const day = store.daily[key] || { learned: 0, correct: 0, total: 0 }
  const today = {
    learned: day.learned + 1,
    correct: day.correct + (correct ? 1 : 0),
    total: day.total + 1
  }

  store.daily[key] = today
  // 待同步的是累计值，不是 +1 的差值
  store.pending.daily[key] = { learned: today.learned, correct: today.correct, total: today.total }

  if (bankId && wordId) {
    const wordKey = `${bankId}:${wordId}`
    const prev = store.words[wordKey] || { seen: 0, correct: 0 }
    const record = {
      seen: prev.seen + 1,
      correct: prev.correct + (correct ? 1 : 0)
    }

    store.words[wordKey] = record
    store.pending.words[wordKey] = { seen: record.seen, correct: record.correct }
  }

  writeStore(store)
  scheduleFlush()

  return today
}

// 某一天的统计
function getDayStats(key) {
  const store = readStore()
  const day = store.daily[key || todayKey()] || { learned: 0, correct: 0, total: 0 }
  const total = day.total || 0
  const accuracy = total > 0 ? Math.round((day.correct / total) * 100) : 0
  const goal = store.goal

  return {
    dateKey: key || todayKey(),
    learned: day.learned,
    correct: day.correct,
    total: total,
    accuracy: accuracy,
    goal: goal,
    checked: day.learned >= goal
  }
}

function getTodayStats() {
  return getDayStats(todayKey())
}

// 连续打卡天数：从今天往前数，今天没达标就从昨天开始数
function getStreak() {
  const store = readStore()
  const goal = store.goal
  let cursor = new Date()
  let streak = 0

  if (!isChecked(store, dateKey(cursor), goal)) {
    cursor = shiftDate(cursor, -1)
  }

  while (isChecked(store, dateKey(cursor), goal)) {
    streak += 1
    cursor = shiftDate(cursor, -1)
  }

  return streak
}

function isChecked(store, key, goal) {
  const day = store.daily[key]

  return !!day && day.learned >= goal
}

// 累计统计
function getTotals() {
  const store = readStore()
  const keys = Object.keys(store.daily)
  let learned = 0
  let correct = 0
  let total = 0

  keys.forEach(key => {
    const day = store.daily[key]

    learned += day.learned || 0
    correct += day.correct || 0
    total += day.total || 0
  })

  return {
    days: keys.length,
    learned: learned,
    correct: correct,
    total: total,
    accuracy: total > 0 ? Math.round((correct / total) * 100) : 0
  }
}

// 最近若干天的记录，用于历史页
function getHistory(limit) {
  const store = readStore()
  const goal = store.goal
  const max = limit || 7
  const records = []

  for (let i = 0; i < max; i += 1) {
    const date = shiftDate(new Date(), -i)
    const key = dateKey(date)
    const day = store.daily[key]

    if (!day || !day.learned) continue

    const total = day.total || 0

    records.push({
      dateKey: key,
      label: `${date.getMonth() + 1} 月 ${date.getDate()} 日`,
      weekday: '周' + '日一二三四五六'.charAt(date.getDay()),
      learned: day.learned,
      correct: day.correct,
      accuracy: total > 0 ? Math.round((day.correct / total) * 100) : 0,
      checked: day.learned >= goal
    })
  }

  return records
}

// 月历：按周分组，周一开头，空格用 empty 占位
function getMonthCalendar(year, month) {
  const store = readStore()
  const goal = store.goal
  const first = new Date(year, month - 1, 1)
  const startWeekday = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const today = todayKey()
  const cells = []

  for (let i = 0; i < startWeekday; i += 1) {
    cells.push({ key: `pad_${i}`, empty: true, day: '' })
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${pad2(month)}-${pad2(day)}`

    cells.push({
      key: key,
      empty: false,
      day: String(day),
      checked: isChecked(store, key, goal),
      isToday: key === today
    })
  }

  while (cells.length % 7 !== 0) {
    cells.push({ key: `pad_end_${cells.length}`, empty: true, day: '' })
  }

  const weeks = []

  for (let i = 0; i < cells.length; i += 7) {
    weeks.push({
      key: `week_${i}`,
      days: cells.slice(i, i + 7)
    })
  }

  return weeks
}

// 每个词的作答记录，key 是 `${bankId}:${wordId}`。
// 分包取词时按 seen 升序挑没背过的词，所以这里一次把整张表给出去，
// 避免在分包里逐词读缓存。
function getWordProgress() {
  return readStore().words
}


/* ---------------- 云端同步 ---------------- */

let flushTimer = null
let flushing = null
let syncing = null
let lastSyncAt = 0

function splitWordKey(key) {
  const index = key.indexOf(':')

  return {
    bankId: key.slice(0, index),
    wordId: key.slice(index + 1)
  }
}

// 把待同步的增量整理成云函数要的格式
function buildPayload(store) {
  const dailyKeys = Object.keys(store.pending.daily)
  const wordKeys = Object.keys(store.pending.words)

  return {
    daily: dailyKeys.map(key => {
      const item = store.pending.daily[key] || {}

      return {
        dateKey: key,
        learned: item.learned || 0,
        correct: item.correct || 0,
        total: item.total || 0
      }
    }),
    words: wordKeys.map(key => {
      const parts = splitWordKey(key)
      const item = store.pending.words[key] || {}

      return {
        bankId: parts.bankId,
        wordId: parts.wordId,
        seen: item.seen || 0,
        correct: item.correct || 0
      }
    }),
    goal: store.pending.goal
  }
}

// 传成功后清掉已经传上去的部分。
// 上传期间可能又背了词，值变大了就留着下次再传，不能直接删。
function clearSent(payload) {
  const store = readStore()
  let changed = false

  payload.daily.forEach(item => {
    const current = store.pending.daily[item.dateKey]

    if (!current) return
    if ((current.learned || 0) > item.learned || (current.correct || 0) > item.correct) return

    delete store.pending.daily[item.dateKey]
    changed = true
  })

  payload.words.forEach(item => {
    const key = `${item.bankId}:${item.wordId}`
    const current = store.pending.words[key]

    if (!current) return
    if ((current.seen || 0) > item.seen || (current.correct || 0) > item.correct) return

    delete store.pending.words[key]
    changed = true
  })

  if (payload.goal !== null && store.pending.goal === payload.goal) {
    store.pending.goal = null
    changed = true
  }

  if (changed) writeStore(store)
}

// 把本地攒下的增量传上去。失败就留在本地，下次再传。
function flushPending() {
  if (!CLOUD_ENABLED || !cloud.isSupported()) return Promise.resolve(false)
  if (flushing) return flushing

  const payload = buildPayload(readStore())

  if (!payload.daily.length && !payload.words.length && payload.goal === null) {
    return Promise.resolve(false)
  }

  flushing = cloud.saveProgress(payload)
    .then(() => {
      clearSent(payload)
      return true
    })
    .catch(error => {
      console.warn('学习进度上传失败，稍后重试：', error)
      return false
    })
    .then(result => {
      flushing = null
      return result
    })

  return flushing
}

// 背词过程中攒一会儿再传，别每背一个词就发一次请求
function scheduleFlush() {
  if (!CLOUD_ENABLED || flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPending()
  }, FLUSH_DELAY)
}

// 把云端数据合进本地。两边都按 max 取，谁多信谁。
function mergeRemote(data) {
  if (!data) return false

  const store = readStore()
  let changed = false

  // 本地有还没传上去的目标时以本地为准，否则跟云端走
  if (store.pending.goal === null && data.goal) {
    const goal = normalizeGoal(data.goal)

    if (goal !== store.goal) {
      store.goal = goal
      changed = true
    }
  }

  const dailyList = data.daily || []

  dailyList.forEach(item => {
    const key = item.dateKey

    if (!key) return

    const local = store.daily[key] || { learned: 0, correct: 0, total: 0 }
    const merged = {
      learned: Math.max(local.learned || 0, item.learned || 0),
      correct: Math.max(local.correct || 0, item.correct || 0),
      total: Math.max(local.total || 0, item.total || 0)
    }

    if (
      merged.learned === (local.learned || 0) &&
      merged.correct === (local.correct || 0) &&
      merged.total === (local.total || 0)
    ) {
      return
    }

    store.daily[key] = merged
    changed = true
  })

  const wordList = data.words || []

  wordList.forEach(item => {
    if (!item.bankId || !item.wordId) return

    const key = `${item.bankId}:${item.wordId}`
    const local = store.words[key] || { seen: 0, correct: 0 }
    const merged = {
      seen: Math.max(local.seen || 0, item.seen || 0),
      correct: Math.max(local.correct || 0, item.correct || 0)
    }

    if (merged.seen === (local.seen || 0) && merged.correct === (local.correct || 0)) {
      return
    }

    store.words[key] = merged
    changed = true
  })

  if (changed) writeStore(store)

  return changed
}

// 拉云端 → 合进本地 → 把本地增量传上去。
// 全程不抛错，失败了就当没同步过，界面继续用本地数据。
function syncNow(options) {
  if (!CLOUD_ENABLED || !cloud.isSupported()) return Promise.resolve(false)
  if (syncing) return syncing

  const force = !!(options && options.force)

  if (!force && Date.now() - lastSyncAt < SYNC_MIN_INTERVAL) {
    return Promise.resolve(false)
  }

  lastSyncAt = Date.now()

  syncing = (async () => {
    try {
      // 本地一条单词记录都没有（比如刚换手机）时多翻几页，把云端进度接回来
      const needFull = Object.keys(readStore().words).length === 0
      const pages = needFull ? cloud.WORD_PAGE_MAX : 1

      for (let i = 0; i < pages; i += 1) {
        const data = await cloud.getProgress({
          wordOffset: i * cloud.WORD_PAGE,
          wordLimit: cloud.WORD_PAGE
        })

        mergeRemote(data)

        if (!data || !data.words || data.words.length < cloud.WORD_PAGE) break
      }

      await flushPending()

      return true
    } catch (error) {
      console.warn('云端同步失败，继续用本地数据：', error)

      return false
    } finally {
      syncing = null
    }
  })()

  return syncing
}

// 清空本地进度，顺带把云端的也清掉（不阻塞界面）
function resetProgress() {
  writeStore({ daily: {}, words: {}, goal: DEFAULT_GOAL, pending: emptyPending() })

  if (CLOUD_ENABLED && cloud.isSupported()) {
    cloud.resetProgress().catch(error => {
      console.warn('清空云端进度失败：', error)
    })
  }
}

module.exports = {
  CLOUD_ENABLED,
  DEFAULT_GOAL,
  GOAL_MIN,
  GOAL_MAX,
  STORAGE_KEY,
  dateKey,
  todayKey,
  buildOptions,
  getGoal,
  setGoal,
  getWordProgress,
  recordAnswer,
  getDayStats,
  getTodayStats,
  getStreak,
  getTotals,
  getHistory,
  getMonthCalendar,
  flushPending,
  syncNow,
  resetProgress
}
