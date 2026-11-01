const layout = require('../../utils/layout')
const cards = require('../../utils/cards')

// 云函数只接受 card_ 开头的卡片 ID，AI 卡片同样满足这个格式
const FAVORITE_ID_PATTERN = /^card_[a-zA-Z0-9_-]{1,64}$/
const SHARE_TOKEN_PATTERN = /^[0-9a-f]{32}$/

// 首屏展示的公开卡片
const DEFAULT_CARD_ID = 'card_001'

// 主题输入框的长度上限
const MAX_INPUT_LENGTH = 30

// 分享 / 跳转带过来的卡片 ID，不合法就回到默认卡片
function resolveCardId(value) {
  return typeof value === 'string' && FAVORITE_ID_PATTERN.test(value)
    ? value
    : DEFAULT_CARD_ID
}

// 长文本自动缩小字号，避免撑破卡片
function textSizeClass(text) {
  const length = (text || '').length

  if (length > 90) return 'is-xxlong'
  if (length > 64) return 'is-xlong'
  if (length > 40) return 'is-long'

  return ''
}

Page({
  data: {
    themeInput: '',
    card: { id: '', theme: '', text: '', english: '', translation: '', tags: [] },
    // loading | ready | empty | error
    cardStatus: 'loading',
    cardError: '',
    // AI 生成中
    generating: false,
    lastMode: 'library',
    libraryOptIn: false,
    generateError: '',
    showEnglish: false,
    dateLabel: '',
    scrollTarget: '',
    savingFavorite: false,
    isFavorited: false,
    // 未公开的 AI 卡片可以收藏，不能向他人分享
    isAiCard: false,
    canFavorite: false,
    canShare: false,
    textSizeClass: '',
    navTop: 28,
    pageBottom: 30
  },

  onLoad(options) {
    const now = new Date()

    // 从分享卡片进来时，直接打开对应的那张公开卡片
    this.hasSharedCardId = !!(options && typeof options.cardId === 'string' && FAVORITE_ID_PATTERN.test(options.cardId))
    this.requestedCardId = resolveCardId(options && options.cardId)
    this.requestedShareToken = options && SHARE_TOKEN_PATTERN.test(options.shareToken || '')
      ? options.shareToken
      : ''

    this.setData({
      dateLabel: `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`
    })
    this.applySafeArea()
    this.enableShareMenu()
    this.loadInitialCard()
  },

  async loadInitialCard() {
    const savedId = wx.getStorageSync('shiguang_last_card_id')
    const savedToken = wx.getStorageSync('shiguang_last_card_token')
    const cardId = this.hasSharedCardId
      ? this.requestedCardId
      : (savedId && FAVORITE_ID_PATTERN.test(savedId) ? savedId : DEFAULT_CARD_ID)
    this.requestedCardId = cardId
    if (!this.hasSharedCardId) {
      this.requestedShareToken = SHARE_TOKEN_PATTERN.test(savedToken || '') ? savedToken : ''
    }
    await this.loadPublicCard()
  },

  onLibraryOptInChange(event) {
    this.setData({ libraryOptIn: Array.isArray(event.detail.value) && event.detail.value.includes('yes') })
  },

  // 不消耗AI次数：按照当前主题抽取已审核卡片
  async drawLibraryCard() {
    if (this.data.generating) return
    const theme = (this.data.themeInput || '').trim()
    this.setData({ generating: true, generateError: '' })
    try {
      const card = await cards.getLibraryCard(theme, this.data.card.id)
      this.applyCard(card, card.sourceType === 'ai')
      this.setData({ lastMode: 'library' })
      this.scrollToCard()
    } catch (error) {
      this.setData({ generateError: (error && error.message) || '暂时无法取卡' })
      wx.showToast({ title: (error && error.message) || '取卡失败', icon: 'none' })
    } finally {
      this.setData({ generating: false })
    }
  },

  // 胶囊菜单里同时打开「转发」和「分享到朋友圈」
  enableShareMenu() {
    if (!wx.showShareMenu) return

    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage', 'shareTimeline']
      })
    } catch (error) {
      console.warn('开启分享菜单失败：', error)
    }
  },

  onShow() {
    // 从收藏页回来时同步收藏状态
    if (this.data.cardStatus !== 'ready') return
    this.refreshFavoriteState(this.data.card && this.data.card.id)
  },

  // 自定义导航栏，需要自己让出胶囊按钮和底部安全区
  applySafeArea() {
    const metrics = layout.getLayoutMetrics()

    this.setData({
      navTop: metrics.navTop,
      pageBottom: 74 + metrics.bottomInset
    })
  },

  // 把一张卡片放到首页上
  applyCard(card, isAiCard) {
    const hasText = !!(card && card.text)

    this.setData({
      card: card,
      cardStatus: hasText ? 'ready' : 'empty',
      cardError: '',
      isAiCard: !!isAiCard,
      canFavorite: hasText && FAVORITE_ID_PATTERN.test(card.id || ''),
      canShare: hasText && card.canShare === true,
      showEnglish: false,
      isFavorited: false,
      textSizeClass: textSizeClass(card.text)
    })
    if (hasText && FAVORITE_ID_PATTERN.test(card.id || '')) {
      wx.setStorageSync('shiguang_last_card_id', card.id)
      wx.setStorageSync('shiguang_last_card_token', card.shareToken || '')
      this.refreshFavoriteState(card.id)
    }
  },

  // 首屏 / 分享带参进入时，加载可访问卡片
  async loadPublicCard() {
    const cardId = this.requestedCardId || DEFAULT_CARD_ID

    this.setData({ cardStatus: 'loading', cardError: '' })

    try {
      const card = await cards.getCard(cardId, this.requestedShareToken)

      this.applyCard(card, card.sourceType === 'ai')

      if (card.text) {
        this.refreshFavoriteState(card.id)
      }
    } catch (error) {
      console.error('读取公开卡片失败：', error)

      this.setData({
        cardStatus: 'error',
        cardError: (error && error.message) || '云端卡片读取失败',
        canFavorite: false,
        canShare: false
      })

      wx.showToast({
        title: '云端卡片读取失败',
        icon: 'none'
      })
    }
  },

  // 卡片区域的「点此重试」：重新加载公开卡片
  retryPublicCard() {
    this.loadPublicCard()
  },

  onThemeInput(event) {
    this.setData({
      themeInput: (event.detail.value || '').slice(0, MAX_INPUT_LENGTH)
    })
  },

  // 随机填入主题，不调用AI，也不抽取卡片
  randomizeTheme() {
    const themes = ['宇宙', '历史', '友情', '学习', '治愈', '旅行', '科技']
    const current = (this.data.themeInput || '').trim()
    const available = themes.filter(theme => theme !== current)
    const options = available.length ? available : themes
    const next = options[Math.floor(Math.random() * options.length)]
    this.setData({ themeInput: next, generateError: '' })
  },

  // ✨ AI 为我创作：只带主题，关键词位置留给后端默认处理
  generate() {
    if (this.data.generating) return

    this.runGenerate({
      theme: (this.data.themeInput || '').trim(),
      keyword: '',
      libraryOptIn: this.data.libraryOptIn
    })
  },

  // 换一张默认浏览卡片库，不消耗每日AI额度
  regenerate() {
    this.drawLibraryCard()
  },

  // 生成失败后重试同一组参数
  retryGenerate() {
    if (this.data.generating) return

    if (this.data.lastMode === 'library') return this.drawLibraryCard()
    this.runGenerate(this.lastGenerateParams || { theme: '', keyword: '', libraryOptIn: this.data.libraryOptIn })
  },

  async runGenerate(params) {
    this.lastGenerateParams = params
    this.setData({ lastMode: 'ai' })
    this.setData({ generating: true, generateError: '' })

    try {
      const card = await cards.generateCard(params)

      this.setData({ generating: false })
      this.applyCard(card, true)
      // 卡面在上、输入区在下，生成后把视线带回卡面
      this.scrollToCard()

      wx.showToast({
        title: '生成完成',
        icon: 'success'
      })
    } catch (error) {
      // 失败时保留上一张正常卡片，只提示错误
      console.error('AI 生成失败：', error)

      const message = (error && error.message) || 'AI 生成失败，请稍后重试'

      this.setData({
        generating: false,
        generateError: message
      })

      wx.showToast({
        title: message,
        icon: 'none'
      })
    }
  },

  // 回到卡面位置，不支持时静默跳过
  scrollToCard() {
    this.setData({ scrollTarget: '' }, () => {
      this.setData({ scrollTarget: 'page-top' })
    })
  },

  // 读取当前卡片的收藏状态，失败时不打断首页
  async refreshFavoriteState(cardId) {
    if (!cardId || !FAVORITE_ID_PATTERN.test(cardId)) {
      this.setData({ isFavorited: false })
      return
    }

    try {
      const res = await wx.cloud.callFunction({
        name: 'favoritesApi',
        data: {
          action: 'list'
        }
      })

      const result = res.result

      if (!result || !result.success) return

      const ids = (result.data || []).map(item => item.id)

      this.setData({
        isFavorited: ids.indexOf(cardId) > -1
      })
    } catch (error) {
      console.warn('读取收藏状态失败：', error)
    }
  },

  // 收藏 / 取消收藏（公开卡片、本人 AI 卡片、通过专属链接访问的 AI 卡片）
  async toggleFavorite() {
    const card = this.data.card

    if (!this.data.canFavorite || !card || !card.id) {
      wx.showToast({
        title: '这张卡片暂时不能收藏',
        icon: 'none'
      })
      return
    }

    if (this.data.savingFavorite) return

    const action = this.data.isFavorited ? 'remove' : 'add'

    this.setData({
      savingFavorite: true
    })

    try {
      const res = await wx.cloud.callFunction({
        name: 'favoritesApi',
        data: {
          action: action,
          cardId: card.id,
          shareToken: card.shareToken || ''
        }
      })

      const result = res.result

      if (result && result.success) {
        this.setData({
          isFavorited: action === 'add'
        })

        wx.showToast({
          title: action === 'add' ? '已收藏' : '已取消收藏',
          icon: 'success'
        })
      } else {
        wx.showToast({
          title: (result && result.message) ||
            (action === 'add' ? '收藏失败' : '取消收藏失败'),
          icon: 'none'
        })
      }
    } catch (error) {
      console.error('收藏操作失败：', error)

      wx.showToast({
        title: '网络异常，请重试',
        icon: 'none'
      })
    } finally {
      this.setData({
        savingFavorite: false
      })
    }
  },

  // 分享信息
  // 私人 AI 卡片通过专属随机口令分享；不自动收入公共卡片库。
  buildShareInfo() {
    const card = this.data.card || {}
    const shareable = this.data.cardStatus === 'ready' &&
      this.data.canShare &&
      FAVORITE_ID_PATTERN.test(card.id || '')

    return {
      title: shareable ? card.text : '拾光 · 每天一点灵感，一点生活。',
      cardId: shareable ? card.id : DEFAULT_CARD_ID,
      shareToken: shareable && SHARE_TOKEN_PATTERN.test(card.shareToken || '')
        ? card.shareToken
        : ''
    }
  },

  // 分享给好友 / 群聊
  onShareAppMessage() {
    const info = this.buildShareInfo()

    const tokenQuery = info.shareToken ? `&shareToken=${info.shareToken}` : ''
    return {
      title: info.title,
      path: `/pages/index/index?cardId=${encodeURIComponent(info.cardId)}${tokenQuery}`
    }
  },

  // 分享到朋友圈
  onShareTimeline() {
    const info = this.buildShareInfo()

    const tokenQuery = info.shareToken ? `&shareToken=${info.shareToken}` : ''
    return {
      title: info.title,
      query: `cardId=${encodeURIComponent(info.cardId)}${tokenQuery}`
    }
  },

  goFavorites() {
    wx.navigateTo({
      url: '/pages/favorites/favorites'
    })
  },

  toggleEnglish() {
    this.setData({ showEnglish: !this.data.showEnglish })
  }
})
