// 词库数据层（分包内）
// 放在分包是因为全量词库约 1.3MB，主包上限只有 2MB，放主包会把首页一起拖慢。
// 注意主包不能 require 分包文件，所以进度统计留在主包的 utils/word-progress.js，
// 这里只负责「取词」，通过 require 主包文件拿到进度。

const progress = require('../../utils/word-progress')

// 词库元数据。total 由数据实际条数回填，不手写，避免和真实数据对不上。
const WORD_BANKS = [
  { id: 'junior', name: '初中', desc: '中考核心词汇', total: 0 },
  { id: 'senior', name: '高中', desc: '高考核心词汇', total: 0 },
  { id: 'cet4', name: '四级', desc: 'CET-4 高频词', total: 0 },
  { id: 'cet6', name: '六级', desc: 'CET-6 高频词', total: 0 }
]

// 数据文件是整条字符串，按换行分条、按竖线分字段：
//   单词|英音|美音|释义|例句|例句翻译
// 用字符串而不是数组/对象，一万四千条下来能省几百 KB。
const RAW_BANKS = {
  junior: require('../data/wordbanks/junior'),
  senior: require('../data/wordbanks/senior'),
  cet4: require('../data/wordbanks/cet4'),
  cet6: require('../data/wordbanks/cet6')
}

// 解析结果缓存，进页面一次、切换词库不再重复切分
const PARSED = {}

function countWords(raw) {
  if (!raw) return 0

  const lines = raw.split('\n')
  let count = 0

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]) count += 1
  }

  return count
}

// 词库总词数（只数行，不解析字段，用于列表展示）
WORD_BANKS.forEach(bank => {
  bank.total = countWords(RAW_BANKS[bank.id])
})

function parseBank(bankId) {
  if (PARSED[bankId]) return PARSED[bankId]

  const raw = RAW_BANKS[bankId] || ''
  const lines = raw.split('\n')
  const list = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (!line) continue

    const parts = line.split('|')

    list.push({
      // 用单词本身当 id，重新生成词库后本地进度依然对得上
      id: parts[0] || '',
      word: parts[0] || '',
      phoneticUk: parts[1] || '',
      phoneticUs: parts[2] || '',
      meaning: parts[3] || '',
      example: parts[4] || '',
      exampleCn: parts[5] || ''
    })
  }

  PARSED[bankId] = list

  return list
}

function cloneWord(word) {
  return {
    id: word.id,
    word: word.word,
    phoneticUk: word.phoneticUk || '',
    phoneticUs: word.phoneticUs || '',
    meaning: word.meaning || '',
    example: word.example || '',
    exampleCn: word.exampleCn || ''
  }
}

function getBank(bankId) {
  return WORD_BANKS.find(bank => bank.id === bankId) || null
}

// 词库本体一直读本地分包里的数据：零延迟、离线可用，
// 也省掉每次进页面一次网络往返。云端的 listWords 留给后台和多端用。
function listBanks() {
  return Promise.resolve(WORD_BANKS.map(bank => Object.assign({}, bank)))
}

function listWords(bankId) {
  return Promise.resolve(parseBank(bankId).map(cloneWord))
}

// 取一个学习会话：优先没背过的词，同优先级内保持词库顺序。
// 这样每天点进来都是新词，而不是每次从头背同十个。
async function getSession(bankId, size) {
  const limit = size || progress.getGoal()
  const pool = parseBank(bankId)

  if (!pool.length) return []

  const seenMap = progress.getWordProgress()
  const scored = pool.map((item, order) => {
    const record = seenMap[`${bankId}:${item.id}`]

    return {
      item: item,
      // 被记录过几次，没背过的为 0，排在前面
      seen: record && record.seen ? record.seen : 0,
      order: order
    }
  })

  scored.sort((a, b) => (a.seen - b.seen) || (a.order - b.order))

  return scored.slice(0, limit).map(entry => cloneWord(entry.item))
}

module.exports = {
  WORD_BANKS,
  getBank,
  listBanks,
  listWords,
  getSession
}
