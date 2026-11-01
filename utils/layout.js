// 页面布局计算
// 小程序是自定义导航栏（navigationStyle: custom），页面顶部会和右上角的胶囊按钮重叠，
// 底部还要让出全面屏的安全区，所以统一在这里算。

function getWindowInfo() {
  try {
    return wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
  } catch (error) {
    return {}
  }
}

// 胶囊按钮底部位置，拿不到时返回 0
function getCapsuleBottom() {
  try {
    const capsule = wx.getMenuButtonBoundingClientRect
      ? wx.getMenuButtonBoundingClientRect()
      : null

    return capsule && capsule.bottom ? capsule.bottom : 0
  } catch (error) {
    return 0
  }
}

function getLayoutMetrics() {
  const info = getWindowInfo()
  const statusBarHeight = info.statusBarHeight || 20
  const screenHeight = info.screenHeight || 0
  const safeArea = info.safeArea || null
  const capsuleBottom = getCapsuleBottom()

  const bottomInset = safeArea && screenHeight
    ? Math.max(0, screenHeight - safeArea.bottom)
    : 0

  return {
    // 让内容落在胶囊按钮下方，取不到胶囊信息时按常见导航栏高度兜底
    navTop: capsuleBottom ? capsuleBottom + 8 : statusBarHeight + 44,
    bottomInset: bottomInset
  }
}

module.exports = {
  getLayoutMetrics
}
