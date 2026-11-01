// 单词模块的云端同步（主包）
//
// 原则是「本地优先」：
//   - 作答先写本地缓存，界面零等待，断网也能用
//   - 攒一批待同步的增量，在合适时机批量补传
//   - 云端按 max 合并，重复上传不会把数字放大，所以失败可以放心重试
//
// 云端不可用时所有功能照常，只是换手机接不上进度。
// 这个文件不 require word-progress，避免两个文件互相依赖；
// 合并规则由调用方传进来的数据决定。

const FUNCTION_NAME = 'wordsApi'

// 单次上行最多带多少条，和云函数里的 SYNC_ITEM_MAX 对齐
const BATCH_SIZE = 200
// 一次拉多少条单词记录
const WORD_PAGE = 500
// 本地没有单词记录时最多翻几页（相当于一次能接回 2000 个词的进度）
const WORD_PAGE_MAX = 4

function isSupported() {
  return typeof wx !== 'undefined' && !!wx.cloud && typeof wx.cloud.callFunction === 'function'
}

async function call(action, payload) {
  const res = await wx.cloud.callFunction({
    name: FUNCTION_NAME,
    data: Object.assign({ action: action }, payload || {})
  })

  const result = res && res.result

  if (!result) {
    throw new Error('云端没有返回数据')
  }

  if (!result.success) {
    throw new Error(result.message || '云端操作失败')
  }

  return result
}

// 拉取进度快照
async function getProgress(options) {
  const payload = options || {}
  const result = await call('getProgress', {
    wordOffset: payload.wordOffset || 0,
    wordLimit: payload.wordLimit || WORD_PAGE
  })

  return result.data || null
}

// 上行合并。条数多了自动分批，目标只随第一批带，避免每批都写一次。
async function saveProgress(payload) {
  const daily = payload.daily || []
  const words = payload.words || []
  const batches = Math.max(
    Math.ceil(daily.length / BATCH_SIZE),
    Math.ceil(words.length / BATCH_SIZE),
    1
  )

  let dailyWritten = 0
  let wordWritten = 0

  for (let i = 0; i < batches; i += 1) {
    const body = {
      daily: daily.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE),
      words: words.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
    }

    if (i === 0 && payload.goal !== undefined && payload.goal !== null) {
      body.goal = payload.goal
    }

    const result = await call('saveProgress', body)
    const data = result.data || {}

    dailyWritten += data.dailyWritten || 0
    wordWritten += data.wordWritten || 0
  }

  return {
    dailyWritten: dailyWritten,
    wordWritten: wordWritten
  }
}

async function setGoal(goal) {
  const result = await call('setGoal', { goal: goal })

  return (result.data && result.data.goal) || goal
}

async function getStats() {
  const result = await call('getStats')

  return result.data || null
}

async function resetProgress() {
  return call('resetProgress')
}

module.exports = {
  BATCH_SIZE,
  WORD_PAGE,
  WORD_PAGE_MAX,
  isSupported,
  getProgress,
  saveProgress,
  setGoal,
  getStats,
  resetProgress
}
