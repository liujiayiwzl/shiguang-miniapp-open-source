const layout = require('../../../utils/layout')
const words = require('../../../utils/word-progress')
const wordbank = require('../../utils/wordbank')

Page({
  data: {
    navTop: 28,
    pageBottom: 30,
    // loading | ready | empty | error
    status: 'loading',
    errorMessage: '',
    banks: [],
    today: {
      learned: 0,
      goal: words.getGoal(),
      accuracy: 0,
      checked: false,
      percent: 0,
      restLabel: ''
    },
    streak: 0,
    goal: words.getGoal(),
    totals: {
      days: 0,
      learned: 0,
      accuracy: 0
    },
    monthLabel: '',
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    weeks: [],
    records: [],
    hasRecords: false,
    canGoNext: false,
    importedTotal: 0
  },

  onLoad() {
    const now = new Date()

    this.year = now.getFullYear()
    this.month = now.getMonth() + 1

    this.applySafeArea()
    this.loadBanks()
  },

  // 从学习页回来时刷新进度和打卡
  onShow() {
    if (this.data.status === 'ready') {
      this.refreshAll()
    }

    // 顺便和云端对一次进度，同步完再刷一遍，把别的设备背的补上
    words.syncNow().then(synced => {
      if (synced) this.refreshAll()
    })
  },

  applySafeArea() {
    const metrics = layout.getLayoutMetrics()

    this.setData({
      navTop: metrics.navTop,
      // 让出底部导航栏
      pageBottom: 74 + metrics.bottomInset
    })
  },

  async loadBanks() {
    this.setData({ status: 'loading', errorMessage: '' })

    try {
      const banks = await wordbank.listBanks()

      if (!banks.length) {
        this.setData({ status: 'empty', banks: [] })
        return
      }

      this.setData({ banks: banks, status: 'ready' })
      this.refreshAll()
    } catch (error) {
      console.error('词库加载失败：', error)

      this.setData({
        status: 'error',
        errorMessage: (error && error.message) || '词库加载失败'
      })
    }
  },

  // 今日进度 + 累计统计 + 月历 + 最近记录
  refreshAll() {
    try {
      const today = words.getTodayStats()
      const totals = words.getTotals()
      const records = words.getHistory(10)
      const weeks = words.getMonthCalendar(this.year, this.month)
      const now = new Date()
      const isCurrentMonth = this.year === now.getFullYear() && this.month === now.getMonth() + 1
      const percent = Math.min(100, Math.round((today.learned / today.goal) * 100))
      const rest = Math.max(0, today.goal - today.learned)

      this.setData({
        today: {
          learned: today.learned,
          goal: today.goal,
          accuracy: today.accuracy,
          checked: today.checked,
          percent: percent,
          restLabel: rest > 0 ? `还差 ${rest} 词` : '今日目标已完成'
        },
        streak: words.getStreak(),
        // 顶部副标题和底部说明都用这个值，改目标后要一起刷新
        goal: today.goal,
        totals: {
          days: totals.days,
          learned: totals.learned,
          accuracy: totals.accuracy
        },
        monthLabel: `${this.year} 年 ${this.month} 月`,
        weeks: weeks,
        records: records,
        hasRecords: records.length > 0,
        canGoNext: !isCurrentMonth,
        importedTotal: wordbank.WORD_BANKS.reduce((sum, bank) => sum + (bank.total || 0), 0)
      })
    } catch (error) {
      console.error('打卡数据加载失败：', error)

      this.setData({
        status: 'error',
        errorMessage: (error && error.message) || '打卡数据加载失败'
      })
    }
  },

  // 改每日目标：常用值直接选，最后一项走自定义输入
  changeGoal() {
    const presets = [5, 10, 15, 20, 30]
    const current = words.getGoal()
    const itemList = presets
      .map(goal => (goal === current ? `${goal} 词（当前）` : `${goal} 词`))
      // showActionSheet 最多 6 项，5 个常用值 + 自定义刚好
      .concat('自定义…')

    wx.showActionSheet({
      itemList: itemList,
      success: (res) => {
        if (res.tapIndex === presets.length) {
          this.inputGoal()
          return
        }

        this.applyGoal(presets[res.tapIndex])
      }
    })
  },

  // 自定义输入，超出范围的值由 setGoal 夹回来
  inputGoal() {
    wx.showModal({
      title: '每日目标',
      editable: true,
      content: String(words.getGoal()),
      placeholderText: `输入 ${words.GOAL_MIN}-${words.GOAL_MAX} 之间的数字`,
      success: (res) => {
        if (!res.confirm) return

        const value = parseInt(res.content, 10)

        if (!value) {
          wx.showToast({ title: '请输入数字', icon: 'none' })
          return
        }

        this.applyGoal(value)
      }
    })
  },

  applyGoal(value) {
    const goal = words.setGoal(value)

    // 目标变了，今日进度、打卡徽章、月历、连续天数都要重算
    this.refreshAll()

    wx.showToast({
      title: `每日目标 ${goal} 词`,
      icon: 'none'
    })
  },

  // 切换月份，不允许翻到未来
  shiftMonth(event) {
    const delta = Number(event.currentTarget.dataset.delta) || 0
    const now = new Date()
    let year = this.year
    let month = this.month + delta

    if (month < 1) {
      month = 12
      year -= 1
    }

    if (month > 12) {
      month = 1
      year += 1
    }

    if (year > now.getFullYear()) return
    if (year === now.getFullYear() && month > now.getMonth() + 1) return

    this.year = year
    this.month = month
    this.refreshAll()
  },

  // 进入某个词库开始背单词
  openBank(event) {
    const bankId = event.currentTarget.dataset.id

    if (!bankId) return

    wx.navigateTo({
      url: `/packageWords/pages/study/study?bankId=${bankId}`
    })
  },

  retry() {
    this.loadBanks()
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.reLaunch({ url: '/pages/index/index' })
  }
})
