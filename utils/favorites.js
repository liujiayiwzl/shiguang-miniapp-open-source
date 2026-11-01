// 收藏数据层
// 已接入 favoritesApi 云函数，收藏列表与取消收藏都走真实数据。
// 如果只想调界面、不想连云端，把 USE_MOCK 改成 true 即可切回本地模拟数据，
// 两种模式返回的卡片字段完全一致，页面不需要改动。

const USE_MOCK = false

// 模拟数据字段与云函数 favoritesApi 返回的卡片格式保持一致
const MOCK_FAVORITES = [
  {
    id: 'card_1001',
    theme: '治愈',
    text: '慢慢来，也是一种前进。',
    english: 'Take your time.',
    translation: '按照自己的节奏来。',
    createdAt: '2026-10-17T01:20:00.000Z'
  },
  {
    id: 'card_1002',
    theme: '有趣',
    text: '计划赶不上变化，快乐可以先到。',
    english: 'Go with the flow.',
    translation: '顺其自然。',
    createdAt: '2026-10-16T09:05:00.000Z'
  },
  {
    id: 'card_1003',
    theme: '思考',
    text: '每一个小小的决定，都可能成为新的开始。',
    english: 'Small steps matter.',
    translation: '每一小步都很重要。',
    createdAt: '2026-10-15T13:40:00.000Z'
  },
  {
    id: 'card_1004',
    theme: '学习',
    text: 'Progress matters more than perfection.',
    english: 'progress',
    translation: '进步',
    createdAt: '2026-10-14T02:18:00.000Z'
  },
  {
    id: 'card_1005',
    theme: '治愈',
    text: '允许自己休息，也是在认真生活。',
    english: 'Rest is productive, too.',
    translation: '休息同样有价值。',
    createdAt: '2026-10-13T11:30:00.000Z'
  }
]

// 会话内的模拟收藏列表，取消收藏会从这里移除，重新编译后恢复
let mockFavorites = MOCK_FAVORITES.slice()

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 统一收口云函数调用：网络异常和业务失败都转成可以直接展示的文案
async function callFavoritesApi(data, fallbackMessage) {
  let res = null

  try {
    res = await wx.cloud.callFunction({
      name: 'favoritesApi',
      data: data
    })
  } catch (error) {
    // 这里拿到的是 request:fail、cloud.callFunction:fail 之类的原始报错
    console.error('调用 favoritesApi 失败：', error)
    throw new Error('网络连接失败，请检查网络后重试')
  }

  const result = res && res.result

  if (!result || !result.success) {
    throw new Error((result && result.message) || fallbackMessage)
  }

  return result
}

// 读取收藏列表
async function listFavorites() {
  if (USE_MOCK) {
    // 留一点延时，方便看到加载态
    await wait(400)
    return mockFavorites.map(item => Object.assign({}, item))
  }

  const result = await callFavoritesApi({ action: 'list' }, '收藏读取失败')

  return result.data || []
}

// 取消收藏
async function removeFavorite(cardId) {
  if (!cardId) {
    throw new Error('缺少卡片信息')
  }

  if (USE_MOCK) {
    await wait(220)
    mockFavorites = mockFavorites.filter(item => item.id !== cardId)
    return true
  }

  await callFavoritesApi({ action: 'remove', cardId: cardId }, '取消收藏失败')

  return true
}

module.exports = {
  listFavorites,
  removeFavorite,
  isMock: USE_MOCK
}
