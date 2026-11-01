const layout = require('../../../utils/layout')
const words = require('../../../utils/word-progress')
const wordbank = require('../../utils/wordbank')
const audio = require('../../utils/word-audio')

Page({
  data: {
    navTop: 28,
    pageBottom: 30,
    // loading | ready | empty | error
    status: 'loading',
    errorMessage: '',
    bankId: '',
    bankName: '',
    // card：翻卡背词 / quiz：四选一
    mode: 'card',
    list: [],
    total: 0,
    index: 0,
    current: {},
    progressLabel: '',
    progressPercent: 0,
    // 翻卡：是否已翻开
    flipped: false,
    // 四选一：选项、选中项、是否已作答
    options: [],
    selectedKey: '',
    answered: false,
    feedbackText: '',
    correctCount: 0,
    finished: false,
    resultAccuracy: 0
  },

  onLoad(options) {
    const bankId = (options && options.bankId) || 'junior'
    const bank = wordbank.getBank(bankId)

    this.applySafeArea()

    if (!bank) {
      this.setData({
        status: 'error',
        errorMessage: '没有找到这个词库'
      })
      return
    }

    this.setData({
      bankId: bank.id,
      bankName: bank.name
    })
    this.loadWords()
  },

  applySafeArea() {
    const metrics = layout.getLayoutMetrics()

    this.setData({
      navTop: metrics.navTop,
      pageBottom: 40 + metrics.bottomInset
    })
  },

  async loadWords() {
    this.setData({ status: 'loading', errorMessage: '' })

    try {
      // 每次只取一个会话的量（10 词），词库有几百个词也不会一次全铺开
      const list = await wordbank.getSession(this.data.bankId)

      if (!list.length) {
        this.setData({ status: 'empty', list: [], total: 0 })
        return
      }

      this.setData({
        status: 'ready',
        list: list,
        total: list.length,
        index: 0,
        correctCount: 0,
        finished: false
      })
      this.applyIndex(0)
    } catch (error) {
      console.error('单词加载失败：', error)

      this.setData({
        status: 'error',
        errorMessage: (error && error.message) || '单词加载失败'
      })
    }
  },

  // 切到第 i 个词，同时重置这一题的作答状态
  applyIndex(i) {
    const list = this.data.list
    const current = list[i] || {}
    const total = list.length || 1

    this.setData({
      index: i,
      current: current,
      flipped: false,
      answered: false,
      selectedKey: '',
      feedbackText: '',
      options: words.buildOptions(current, list),
      progressLabel: `${i + 1} / ${list.length}`,
      progressPercent: Math.round((i / total) * 100)
    })
  },

  // 翻卡：点击卡片翻转
  toggleCard() {
    if (this.data.mode !== 'card' || this.data.finished) return

    this.setData({ flipped: !this.data.flipped })
  },

  // 点音标听发音，英式美式各一个
  playAudio(event) {
    const accent = event.currentTarget.dataset.accent || 'us'
    const current = this.data.current || {}

    if (!current.word) return

    audio.play(current.word, accent)
  },

  // 认识：记为答对，进入下一个
  markKnown() {
    if (this.data.finished || this.data.answered) return

    this.record(true)
    this.setData({ correctCount: this.data.correctCount + 1 })
    this.next()
  },

  // 不认识：记为答错，进入下一个
  markUnknown() {
    if (this.data.finished || this.data.answered) return

    this.record(false)
    this.next()
  },

  // 下一张：跳过，不计入正确率
  skip() {
    if (this.data.finished) return

    this.next()
  },

  // 四选一：点选项
  chooseOption(event) {
    if (this.data.answered || this.data.finished) return

    const key = event.currentTarget.dataset.key
    const options = this.data.options
    let picked = null

    for (let i = 0; i < options.length; i += 1) {
      if (options[i].key === key) {
        picked = options[i]
        break
      }
    }

    if (!picked) return

    const correct = !!picked.correct
    const rightOne = options.filter(item => item.correct)[0]

    this.setData({
      selectedKey: key,
      answered: true,
      feedbackText: correct
        ? '回答正确'
        : `正确答案：${(rightOne && rightOne.meaning) || ''}`
    })

    this.record(correct)

    if (correct) {
      this.setData({ correctCount: this.data.correctCount + 1 })
    }
  },

  // 四选一：下一题
  nextQuestion() {
    if (!this.data.answered || this.data.finished) return

    this.next()
  },

  // 记一次作答，同时检查今天是否刚好达成打卡
  record(correct) {
    const current = this.data.current || {}
    const goal = words.getGoal()
    // 先取学习前的进度，用来判断这一词是否让今天跨过目标线
    const before = words.getTodayStats().learned

    words.recordAnswer({
      bankId: this.data.bankId,
      wordId: current.id,
      correct: correct
    })

    const after = words.getTodayStats().learned

    // 用「跨过」而不是「等于」判断：一天里可能背第二组，
    // 学过的词数会越过目标而不再等于目标，等于判断会漏掉提示。
    if (before < goal && after >= goal) {
      wx.showToast({
        title: '今日打卡完成',
        icon: 'success'
      })
    }
  },

  // 进入下一个词，到底了就结算本轮
  next() {
    const nextIndex = this.data.index + 1

    if (nextIndex >= this.data.list.length) {
      const total = this.data.list.length
      const correctCount = this.data.correctCount

      this.setData({
        finished: true,
        progressPercent: 100,
        progressLabel: `${total} / ${total}`,
        resultAccuracy: total > 0 ? Math.round((correctCount / total) * 100) : 0
      })
      return
    }

    this.applyIndex(nextIndex)
  },

  // 切换学习模式，当前词不重新开始
  switchMode(event) {
    const mode = event.currentTarget.dataset.mode

    if (!mode || mode === this.data.mode) return

    this.setData({
      mode: mode,
      flipped: false,
      answered: false,
      selectedKey: '',
      feedbackText: ''
    })
  },

  // 再来一轮
  restart() {
    this.setData({
      finished: false,
      correctCount: 0,
      resultAccuracy: 0
    })
    this.applyIndex(0)
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.reLaunch({ url: '/packageWords/pages/history/history' })
  },

  onUnload() {
    audio.destroy()
    // 一轮背完把进度传上去，不等那 10 秒的攒批
    words.flushPending()
  },

  onHide() {
    words.flushPending()
  }
})
