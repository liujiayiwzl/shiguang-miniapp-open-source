const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const CARD_ID = /^card_[a-zA-Z0-9_-]{1,64}$/

function publicCard(card) {
  return {
    id: card.id,
    theme: card.theme || '随心',
    text: card.text || '',
    english: card.english || '',
    translation: card.translation || '',
    tags: Array.isArray(card.tags)
      ? card.tags.filter(tag => typeof tag === 'string').slice(0, 2)
      : [],
    sourceType: card.sourceType || 'preset',
    canShare: true,
    createdAt: card.createdAt || ''
  }
}

// 初始精选库：只包含人工检查的通用内容，不包含用户私密创作。
const SEED_CARDS = [
  [
    "宇宙",
    "月球总以同一面对着地球，是因为它的自转周期与公转周期相同。",
    "The Moon keeps one face toward us.",
    "月球始终以同一面朝向地球。",
    [
      "宇宙",
      "月球"
    ]
  ],
  [
    "宇宙",
    "阳光从太阳来到地球，大约需要八分钟。",
    "Sunlight takes time to reach us.",
    "阳光到达地球需要时间。",
    [
      "宇宙",
      "太阳"
    ]
  ],
  [
    "历史",
    "古代的丝绸之路不是一条路，而是连接不同地区的贸易网络。",
    "History connects distant places.",
    "历史连接遥远的地方。",
    [
      "历史",
      "文化"
    ]
  ],
  [
    "历史",
    "活字印刷让单个字模可以重复使用，改变了文字传播的方式。",
    "Ideas travel through print.",
    "思想随着印刷传播。",
    [
      "历史",
      "发明"
    ]
  ],
  [
    "友情",
    "真正的朋友，不一定时时联系，却愿意认真听你说话。",
    "Good friends make time to listen.",
    "好朋友愿意花时间倾听。",
    [
      "友情",
      "倾听"
    ]
  ],
  [
    "友情",
    "一句真诚的问候，有时就是维系友谊最好的方式。",
    "A small hello can mean a lot.",
    "一句问候也能意义非凡。",
    [
      "友情",
      "关怀"
    ]
  ],
  [
    "学习",
    "记住一个知识点后，试着不用笔记向别人讲清楚它。",
    "Teach it to learn it.",
    "通过讲解加深学习。",
    [
      "学习",
      "方法"
    ]
  ],
  [
    "学习",
    "难题可以先拆成小问题，再逐个寻找答案。",
    "Break it down step by step.",
    "把问题一步步拆解。",
    [
      "学习",
      "思考"
    ]
  ],
  [
    "治愈",
    "今天可以不完美，重要的是认真经历了这一天。",
    "Today does not need to be perfect.",
    "今天不必完美。",
    [
      "治愈",
      "生活"
    ]
  ],
  [
    "治愈",
    "窗外的光正在慢慢变化，你也可以按自己的节奏前进。",
    "Move at your own pace.",
    "按照自己的节奏前进。",
    [
      "治愈",
      "成长"
    ]
  ],
  [
    "旅行",
    "走进一条陌生的街道，也可能遇见熟悉的生活气息。",
    "Every street has a story.",
    "每条街都有故事。",
    [
      "旅行",
      "城市"
    ]
  ],
  [
    "科技",
    "二维码把信息排列成黑白方块，让设备可以快速读取。",
    "Patterns can carry information.",
    "图案也能承载信息。",
    [
      "科技",
      "知识"
    ]
  ]
]

async function ensureSeedLibrary() {
  const existing = await db.collection('cards').where({ id: 'card_library_001' }).limit(1).get()
  if (existing.data.length) return
  // 并发写入固定ID的精选卡片，避免首批初始化时云函数等待太久。
  await Promise.all(SEED_CARDS.map(async (row, i) => {
    const [theme, text, english, translation, tags] = row
    const id = 'card_library_' + String(i + 1).padStart(3, '0')
    const existingCard = await db.collection('cards').where({ id }).limit(1).get()
    if (existingCard.data.length) return
    await db.collection('cards').doc(id).set({
      data: { id, theme, text, english, translation, tags,
        sourceType: 'preset', visibility: 'public', status: 'approved',
        createdAt: db.serverDate() }
    })
  }))
}

// 随手一张：按自由主题从审核通过的公共卡片库抽取。
// 可以抽到人工卡片，也可以抽到经审核允许公开的 AI 卡片。
// 不调用 AI 模型，不消耗每日 AI 额度。
exports.main = async (event) => {
  try {
    const theme = typeof (event && event.theme) === 'string'
      ? event.theme.trim()
      : ''

    if (theme.length > 30) {
      return { success: false, message: '主题不能超过30个字' }
    }

    const excludeId = typeof (event && event.excludeId) === 'string' &&
      CARD_ID.test(event.excludeId)
      ? event.excludeId
      : ''

    const publicFilter = {
      visibility: 'public',
      status: 'approved'
    }

    // 有主题时，只抽取主题字段或标签匹配的卡片；
    // 无主题时，随机抽取所有公开且审核通过的卡片。
    const filter = theme
      ? _.and([
          publicFilter,
          _.or([
            { theme: theme },
            { tags: theme }
          ])
        ])
      : publicFilter

    await ensureSeedLibrary()
    const cards = db.collection('cards')
    const countResult = await cards.where(filter).count()
    const total = countResult.total || 0

    // 没有匹配时不偷偷调用 AI，也不返回无关主题的卡片。
    if (total === 0) {
      return {
        success: true,
        data: null,
        message: theme
          ? '卡片库里暂时没有这个主题，试试其他主题或留空随机抽取'
          : '卡片库正在准备中，请稍后再来'
      }
    }

    let index = Math.floor(Math.random() * total)
    let result = await cards.where(filter).skip(index).limit(1).get()
    let card = result.data && result.data[0]

    // 尽量不连续抽到上一张；如果只有一张，允许再次抽到。
    if (card && total > 1 && card.id === excludeId) {
      index = (index + 1) % total
      result = await cards.where(filter).skip(index).limit(1).get()
      card = result.data && result.data[0]
    }

    if (!card) {
      return {
        success: false,
        message: '暂时无法获取卡片，请稍后重试'
      }
    }

    return {
      success: true,
      data: publicCard(card)
    }
  } catch (error) {
    console.error('getLibraryCard错误：', error)
    return {
      success: false,
      message: '卡片库加载失败，请稍后再试'
    }
  }
}
