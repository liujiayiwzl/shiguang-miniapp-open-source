// 端到端验证「本地 → 云函数 → 本地」的同步链路。
// 用一个假的 wx 对象模拟小程序环境，cloud.callFunction 直接打到内存版 wordsApi。

const path = require('path')
const { createServer } = require('./mock-cloud-db')

const server = createServer()

/* ---------- 假的小程序环境 ---------- */

const storage = new Map()
let online = true

const wx = {
  getStorageSync: key => (storage.has(key) ? JSON.parse(storage.get(key)) : ''),
  setStorageSync: (key, value) => { storage.set(key, JSON.stringify(value)) },
  showToast: () => {},
  cloud: {
    callFunction: async options => {
      if (!online) throw new Error('网络不可用')
      return { result: await server.main(options.data) }
    }
  }
}

global.wx = wx

const words = require(path.join(__dirname, '..', 'utils/word-progress.js'))

/* ---------- 测试框架 ---------- */

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass += 1; console.log('  ok  ' + label) }
  else { fail += 1; console.log('  FAIL ' + label + '\n      期望 ' + e + '\n      实际 ' + a) }
}

function today(offsetDays) {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  now.setUTCDate(now.getUTCDate() + (offsetDays || 0))
  return now.toISOString().slice(0, 10)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 直接读云端的原始数据，用来断言「到底传上去了没有」
async function cloudDaily() {
  const res = await server.main({ action: 'getProgress', wordLimit: 500 })
  return res.data
}

async function main() {
  console.log('\n[1] 本地作答会攒进待同步队列')
  words.recordAnswer({ bankId: 'cet4', wordId: 'image', correct: true })
  words.recordAnswer({ bankId: 'cet4', wordId: 'image', correct: false })
  words.recordAnswer({ bankId: 'cet4', wordId: 'issue', correct: true })

  const local = words.getTodayStats()
  check('本地今日 3 词', local.learned, 3)
  check('本地正确 2 词', local.correct, 2)

  const store = JSON.parse(storage.get(words.STORAGE_KEY))
  check('待同步里有今天的记录', store.pending.daily[today(0)].learned, 3)
  check('待同步里有 2 个词', Object.keys(store.pending.words).length, 2)
  check('云端此时还没有数据', (await cloudDaily()).daily.length, 0)

  console.log('\n[2] 补传后云端拿到数据')
  const flushed = await words.flushPending()
  check('上传成功', flushed, true)

  const remote = await cloudDaily()
  check('云端有今天的记录', remote.daily.length, 1)
  check('云端今日词数', remote.daily[0].learned, 3)
  check('云端单词记录', remote.words.length, 2)

  const after = JSON.parse(storage.get(words.STORAGE_KEY))
  check('待同步已清空', Object.keys(after.pending.daily).length, 0)
  check('目标没有被误传', after.pending.goal, null)

  console.log('\n[3] 重复补传不会把数字翻倍')
  await words.flushPending()
  check('云端还是 3 词', (await cloudDaily()).daily[0].learned, 3)

  console.log('\n[4] 换设备：本地空了，从云端接回进度')
  storage.clear()
  check('新设备本地为空', words.getTodayStats().learned, 0)

  const synced = await words.syncNow({ force: true })
  check('同步成功', synced, true)
  check('接回今日 3 词', words.getTodayStats().learned, 3)
  check('接回 2 个单词记录', Object.keys(words.getWordProgress()).length, 2)
  check('接回的 seen 正确', words.getWordProgress()['cet4:image'].seen, 2)

  console.log('\n[5] 两台设备各自背的词会合并')
  // 模拟另一台设备又背了 2 个词
  await server.main({
    action: 'saveProgress',
    daily: [{ dateKey: today(0), learned: 5, correct: 4, total: 5 }],
    words: [{ bankId: 'cet4', wordId: 'image', seen: 3, correct: 2 }]
  })

  await words.syncNow({ force: true })
  check('合并后取较大值', words.getTodayStats().learned, 5)
  check('合并后单词 seen 取较大值', words.getWordProgress()['cet4:image'].seen, 3)

  console.log('\n[6] 每日目标云端同步')
  words.setGoal(30)
  await words.flushPending()
  check('本地目标 30', words.getGoal(), 30)

  const goalRes = await server.main({ action: 'getGoal' })
  check('云端目标 30', goalRes.data.goal, 30)

  storage.clear()
  await words.syncNow({ force: true })
  check('新设备拉到 30', words.getGoal(), 30)

  console.log('\n[7] 断网时功能不受影响，增量留在本地')
  online = false
  words.recordAnswer({ bankId: 'cet4', wordId: 'program', correct: true })
  check('断网也能记进度', words.getTodayStats().learned >= 1, true)
  check('上传失败返回 false', await words.flushPending(), false)
  check('同步失败返回 false', await words.syncNow({ force: true }), false)

  const offline = JSON.parse(storage.get(words.STORAGE_KEY))
  check('增量还在本地', Object.keys(offline.pending.words).length >= 1, true)

  console.log('\n[8] 恢复网络后把断网期间的补上')
  online = true
  await words.flushPending()
  const recovered = JSON.parse(storage.get(words.STORAGE_KEY))
  check('待同步清空', Object.keys(recovered.pending.words).length, 0)

  console.log('\n[9] 防抖：短时间内重复调用只同步一次')
  const first = await words.syncNow({ force: true })
  const second = await words.syncNow()
  check('第一次同步成功', first, true)
  check('第二次被节流跳过', second, false)

  console.log('\n[10] 清空进度同时清云端')
  words.resetProgress()
  check('本地清空', words.getTodayStats().learned, 0)
  await sleep(50)
  check('云端清空', (await cloudDaily()).daily.length, 0)

  console.log('\n[11] 云端不可用时的降级')
  const saved = wx.cloud
  wx.cloud = undefined
  check('不支持时 flush 返回 false', await words.flushPending(), false)
  check('不支持时 sync 返回 false', await words.syncNow({ force: true }), false)
  check('本地功能照常', (words.recordAnswer({ bankId: 'cet4', wordId: 'guy', correct: true }), words.getTodayStats().learned), 1)
  wx.cloud = saved

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(error => {
  console.error('测试异常：', error)
  process.exit(1)
})
