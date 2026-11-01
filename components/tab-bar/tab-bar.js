const layout = require('../../utils/layout')

// 底部导航：首页 / 打卡 / 我的
// 三个都是顶层页面，用 reLaunch 切换，避免页面栈越堆越深
const ROUTES = {
  home: '/pages/index/index',
  checkin: '/packageWords/pages/history/history',
  mine: '/pages/mine/mine'
}

Component({
  properties: {
    active: {
      type: String,
      value: 'home'
    }
  },

  data: {
    bottomInset: 0
  },

  attached() {
    const metrics = layout.getLayoutMetrics()

    this.setData({ bottomInset: metrics.bottomInset })
  },

  methods: {
    onTap(event) {
      const key = event.currentTarget.dataset.key

      if (!key || key === this.data.active) return

      const url = ROUTES[key]

      if (!url) return

      wx.reLaunch({ url: url })
    }
  }
})
