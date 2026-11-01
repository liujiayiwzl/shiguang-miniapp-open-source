// 用内存数据库模拟 wx-server-sdk，验证 wordsApi 的合并/统计/边界逻辑
const { createServer } = require('./mock-cloud-db')

const server = createServer()
const api = server

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

async function main() {
  console.log('\n[1] 新用户默认目标')
  let r = await api.main({ action: 'getGoal' })
  check('getGoal 返回 10', r, { success: true, data: { goal: 10 } })

  console.log('\n[2] 设置目标')
  r = await api.main({ action: 'setGoal', goal: 25 })
  check('setGoal 25', r.data, { goal: 25 })
  r = await api.main({ action: 'setGoal', goal: 999 })
  check('超上限夹到 100', r.data, { goal: 100 })
  r = await api.main({ action: 'setGoal', goal: 'abc' })
  check('非法值报错', r.success, false)
  await api.main({ action: 'setGoal', goal: 10 })

  console.log('\n[3] 首次上行同步')
  const d0 = today(0)
  const d1 = today(-1)
  r = await api.main({
    action: 'saveProgress',
    goal: 10,
    daily: [
      { dateKey: d1, learned: 12, correct: 10, total: 12 },
      { dateKey: d0, learned: 4, correct: 3, total: 4 }
    ],
    words: [
      { bankId: 'cet4', wordId: 'image', seen: 2, correct: 1 },
      { bankId: 'cet4', wordId: 'issue', seen: 1, correct: 1 }
    ]
  })
  check('写入条数', r.data, { goal: 10, dailyWritten: 2, wordWritten: 2 })

  console.log('\n[4] 重复上传同样的数据（幂等）')
  r = await api.main({
    action: 'saveProgress',
    daily: [
      { dateKey: d1, learned: 12, correct: 10, total: 12 },
      { dateKey: d0, learned: 4, correct: 3, total: 4 }
    ],
    words: [
      { bankId: 'cet4', wordId: 'image', seen: 2, correct: 1 },
      { bankId: 'cet4', wordId: 'issue', seen: 1, correct: 1 }
    ]
  })
  check('不重复写', r.data, { goal: 10, dailyWritten: 0, wordWritten: 0 })

  console.log('\n[5] 只涨不跌（max 合并）')
  r = await api.main({
    action: 'saveProgress',
    daily: [{ dateKey: d0, learned: 2, correct: 1, total: 2 }],
    words: [{ bankId: 'cet4', wordId: 'image', seen: 1, correct: 0 }]
  })
  check('旧的小值不覆盖', r.data, { goal: 10, dailyWritten: 0, wordWritten: 0 })

  console.log('\n[6] 增量累加')
  r = await api.main({
    action: 'saveProgress',
    daily: [{ dateKey: d0, learned: 10, correct: 8, total: 10 }],
    words: [{ bankId: 'cet4', wordId: 'image', seen: 5, correct: 4 }]
  })
  check('更大的值写进去', r.data, { goal: 10, dailyWritten: 1, wordWritten: 1 })

  console.log('\n[7] 拉取进度')
  r = await api.main({ action: 'getProgress' })
  check('目标', r.data.goal, 10)
  check('今天日期', r.data.today, d0)
  check('每日记录条数', r.data.daily.length, 2)
  check('单词记录条数', r.data.words.length, 2)
  check('今天的 learned', r.data.daily.filter(d => d.dateKey === d0)[0].learned, 10)
  check('不返回 openid', Object.keys(r.data.daily[0]).sort(), ['correct', 'dateKey', 'learned', 'total'])

  console.log('\n[8] 汇总统计 + 连续打卡')
  r = await api.main({ action: 'getStats' })
  check('累计天数', r.data.days, 2)
  check('累计词数', r.data.learned, 22)
  check('连续打卡 2 天', r.data.streak, 2)
  check('今日已打卡', r.data.today.checked, true)
  check('正确率', r.data.accuracy, Math.round((18 / 22) * 100))

  console.log('\n[9] 学习记录')
  r = await api.main({ action: 'getHistory', limit: 7 })
  check('按日期倒序', r.data.map(x => x.dateKey), [d0, d1])
  check('打卡标记', r.data.map(x => x.checked), [true, true])

  console.log('\n[10] 打卡日历')
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  r = await api.main({ action: 'getCalendar', year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 })
  check('天数与当月一致', r.data.days.length, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate())
  check('今天在日历里', r.data.days.filter(d => d.isToday).length, 1)
  check('今天已打卡', r.data.days.filter(d => d.isToday)[0].checked, true)

  console.log('\n[11] 脏数据夹取')
  const d2 = today(-2)
  r = await api.main({
    action: 'saveProgress',
    daily: [
      { dateKey: 'bad-date', learned: 5 },
      { dateKey: d2, learned: -3, correct: 5, total: 0 }
    ],
    words: [
      { bankId: 'cet4', wordId: 'a|b', seen: 1 },
      { bankId: 'CET4!', wordId: 'image', seen: 1 },
      { bankId: 'cet4', wordId: 'image', seen: 99999, correct: 99999 }
    ]
  })
  check('非法项被丢弃', r.data.dailyWritten + r.data.wordWritten, 1)
  check('全零的日期不落库', r.data.dailyWritten, 0)
  r = await api.main({ action: 'getProgress' })
  check('库里没有空日期', r.data.daily.some(d => d.dateKey === d2), false)
  const badWord = r.data.words.filter(w => w.wordId === 'image')[0]
  check('seen 夹到 999', badWord.seen, 999)
  check('correct 不超过 seen', badWord.correct <= badWord.seen, true)

  console.log('\n[12] 参数校验')
  check('未知 action', (await api.main({ action: 'nope' })).success, false)
  check('空 event', (await api.main()).success, false)
  check('listWords 非法 bankId', (await api.main({ action: 'listWords', bankId: 'A!' })).success, false)
  check('getCalendar 非法月份', (await api.main({ action: 'getCalendar', year: 2026, month: 13 })).success, false)
  check('超量同步', (await api.main({ action: 'saveProgress', daily: new Array(401).fill({ dateKey: d0, learned: 1 }) })).success, false)

  console.log('\n[13] 集合缺失时降级')
  check('listBanks 返回空数组', (await api.main({ action: 'listBanks' })).data, [])
  check('listWords 返回空数组', (await api.main({ action: 'listWords', bankId: 'cet4' })).data, [])

  console.log('\n[14] 未登录')
  server.setOpenid('')
  check('无 openid 拒绝', (await api.main({ action: 'getGoal' })).success, false)
  server.setOpenid('openid_test_user')

  console.log('\n[15] 多用户隔离')
  server.setOpenid('openid_other')
  check('新用户看不到别人的进度', (await api.main({ action: 'getProgress' })).data.daily.length, 0)
  server.setOpenid('openid_test_user')

  console.log('\n[16] 清空')
  r = await api.main({ action: 'resetProgress' })
  check('删掉的条数', r.data.removed >= 4, true)
  check('清空后没有记录', (await api.main({ action: 'getProgress' })).data.daily.length, 0)

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(error => {
  console.error('测试异常：', error)
  process.exit(1)
})
