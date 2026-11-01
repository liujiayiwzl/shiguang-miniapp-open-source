// 卡片数据层
// 1. generateCard：AI 创作卡片（自由主题 + 关键词，都可以为空）
// 2. getCard：读取公开且审核通过的指定卡片（例如 card_001）
// 云函数代码不在前端维护，这里只负责调用和统一错误文案。

// 把云函数返回的卡片补齐成前端可以直接用的结构
function normalizeCard(card) {
  const source = card || {}

  return {
    id: source.id || '',
    theme: source.theme || '',
    text: source.text || '',
    english: source.english || '',
    translation: source.translation || '',
    // 后端最多返回两个标签，这里再兜一层，缺失时给空数组
    tags: Array.isArray(source.tags)
      ? source.tags.filter(tag => !!tag).slice(0, 2)
      : [],
    sourceType: source.sourceType || '',
    canShare: source.canShare === true,
    shareToken: typeof source.shareToken === 'string' ? source.shareToken : '',
    createdAt: source.createdAt || ''
  }
}

// 统一收口云函数调用：网络异常和业务失败都转成可以直接展示的文案
async function callFunction(name, data, fallbackMessage) {
  let res = null

  try {
    res = await wx.cloud.callFunction({
      name: name,
      data: data
    })
  } catch (error) {
    console.error('调用云函数失败：', name, error)
    throw new Error('网络连接失败，请检查网络后重试')
  }

  const result = res && res.result

  if (!result || !result.success) {
    throw new Error((result && result.message) || fallbackMessage)
  }

  return result
}

// AI 创作一张卡片
// 参数：{ theme, keyword }，两个都可以是空字符串
async function generateCard(params) {
  const theme = (params && params.theme) || ''
  const keyword = (params && params.keyword) || ''

  const result = await callFunction(
    'generateCard',
    { theme: theme, keyword: keyword, libraryOptIn: !!(params && params.libraryOptIn) },
    'AI 生成失败，请稍后重试'
  )

  return normalizeCard(result.data)
}

// 读取公开卡片
async function getPublicCard(cardId) {
  const result = await callFunction(
    'getCard',
    { id: cardId },
    '云端卡片读取失败'
  )

  return normalizeCard(result.data)
}

// 从已审核卡片库按主题抽一张，不消耗AI次数
async function getLibraryCard(theme, excludeId) {
  const result = await callFunction(
    'getLibraryCard',
    { theme: theme || '', excludeId: excludeId || '' },
    '获取卡片失败，请稍后重试'
  )
  if (!result.data) throw new Error(result.message || '暂时没有匹配主题的卡片')
  return normalizeCard(result.data)
}

// 只允许云端判定可访问的数据（公开卡片或本人生成）
async function getCard(cardId, shareToken) {
  const result = await callFunction('getCard', { id: cardId, shareToken: shareToken || '' }, '读取卡片失败')
  return normalizeCard(result.data)
}

module.exports = {
  generateCard,
  getPublicCard,
  getLibraryCard,
  getCard,
  normalizeCard
}
