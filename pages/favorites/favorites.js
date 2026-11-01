const favoritesStore = require('../../utils/favorites')
const layout = require('../../utils/layout')

// 把云函数返回的时间统一格式化成 2026.10.17
function formatDateLabel(value) {
  if (!value) return ''

  let date = null

  if (value instanceof Date) {
    date = value
  } else if (typeof value === 'number') {
    date = new Date(value)
  } else if (typeof value === 'string') {
    date = new Date(value)
  } else if (value && value.$date) {
    date = new Date(value.$date)
  }

  if (!date || isNaN(date.getTime())) return ''

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}.${month}.${day}`
}

// 长文本自动缩小字号，避免撑破卡片
function textSizeClass(text) {
  const length = (text || '').length

  if (length > 64) return 'is-xlong'
  if (length > 40) return 'is-long'

  return ''
}

Page({
  data: {
    // loading | ready | empty | error
    status: 'loading',
    errorMessage: '',
    favorites: [],
    countLabel: '',
    detail: null,
    removingId: '',
    isMock: favoritesStore.isMock,
    navTop: 28,
    pageBottom: 36,
    // scroll-view 自带的下拉刷新状态（Skyline 没有页面级下拉）
    refreshing: false
  },

  onLoad() {
    this.applySafeArea()
    this.loadFavorites()
  },

  // 下拉刷新：Skyline 没有页面级下拉，用 scroll-view 的 refresher
  async onRefresh() {
    this.setData({ refreshing: true })

    try {
      await this.loadFavorites()
    } finally {
      this.setData({ refreshing: false })
    }
  },

  // 自定义导航栏，需要自己让出胶囊按钮和底部安全区
  applySafeArea() {
    const metrics = layout.getLayoutMetrics()

    this.setData({
      navTop: metrics.navTop,
      pageBottom: 36 + metrics.bottomInset
    })
  },

  async loadFavorites() {
    this.setData({ status: 'loading', errorMessage: '' })

    try {
      const list = await favoritesStore.listFavorites()

      const favorites = list.map(item => ({
        id: item.id,
        theme: item.theme || '拾光',
        text: item.text || '',
        english: item.english || '',
        translation: item.translation || '',
        dateLabel: formatDateLabel(item.createdAt),
        sizeClass: textSizeClass(item.text)
      }))

      this.setData({
        favorites,
        countLabel: favorites.length ? `${favorites.length} 张` : '',
        status: favorites.length ? 'ready' : 'empty'
      })
    } catch (error) {
      console.error('读取收藏失败：', error)

      this.setData({
        status: 'error',
        errorMessage: (error && error.message) || '请检查网络后重试'
      })
    }
  },

  // 点击卡片查看内容
  openDetail(event) {
    const id = event.currentTarget.dataset.id
    const detail = this.data.favorites.find(item => item.id === id)

    if (!detail) return

    this.setData({ detail })
  },

  closeDetail() {
    this.setData({ detail: null })
  },

  // 详情浮层内部点击不穿透
  stopTap() {},

  async handleRemove(event) {
    const cardId = event.currentTarget.dataset.id ||
      (this.data.detail && this.data.detail.id)

    if (!cardId || this.data.removingId) return

    this.setData({ removingId: cardId })

    try {
      await favoritesStore.removeFavorite(cardId)

      const favorites = this.data.favorites.filter(item => item.id !== cardId)

      this.setData({
        favorites,
        countLabel: favorites.length ? `${favorites.length} 张` : '',
        status: favorites.length ? 'ready' : 'empty',
        detail: null
      })

      wx.showToast({
        title: '已取消收藏',
        icon: 'success'
      })
    } catch (error) {
      console.error('取消收藏失败：', error)

      wx.showToast({
        title: (error && error.message) || '取消收藏失败，请重试',
        icon: 'none'
      })
    } finally {
      this.setData({ removingId: '' })
    }
  },

  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1 })
      return
    }

    wx.reLaunch({ url: '/pages/index/index' })
  },

  goHome() {
    this.goBack()
  }
})
