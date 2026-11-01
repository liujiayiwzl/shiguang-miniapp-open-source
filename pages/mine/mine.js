const layout = require('../../utils/layout')
const words = require('../../utils/word-progress')

Page({
  data: {
    navTop: 28,
    pageBottom: 30,
    today: { learned: 0, goal: words.getGoal() },
    streak: 0,
    totals: { days: 0, learned: 0, accuracy: 0 },
    cloudEnabled: words.CLOUD_ENABLED
  },

  onLoad() {
    this.applySafeArea()
  },

  onShow() {
    this.refresh()
  },

  applySafeArea() {
    const metrics = layout.getLayoutMetrics()

    this.setData({
      navTop: metrics.navTop,
      // 让出底部导航栏
      pageBottom: 74 + metrics.bottomInset
    })
  },

  refresh() {
    const today = words.getTodayStats()
    const totals = words.getTotals()

    this.setData({
      today: { learned: today.learned, goal: today.goal },
      streak: words.getStreak(),
      totals: {
        days: totals.days,
        learned: totals.learned,
        accuracy: totals.accuracy
      }
    })
  },

  goFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' })
  }
})
