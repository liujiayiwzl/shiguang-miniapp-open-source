// 单词发音（分包内）
// 英式、美式各一个读音，点击音标时播放。
//
// 音频来源用的是有道词典的公开接口：
//   https://dict.youdao.com/dictvoice?audio=image&type=1   英式
//   https://dict.youdao.com/dictvoice?audio=image&type=2   美式
// 换自己的音频服务时只改 buildUrl 即可。
//
// 真机要在微信后台把 dict.youdao.com 加进 downloadFile 合法域名，
// 否则第一次播放就会失败；失败时这里只提示一次，不会反复弹 toast。

const BASE_URL = 'https://dict.youdao.com/dictvoice'

// 1 = 英式，2 = 美式
const ACCENT_TYPE = {
  uk: 1,
  us: 2
}

// 连续失败这么多次就不再尝试，避免用户每点一次弹一次提示
const MAX_FAILURES = 2

let context = null
let failures = 0

function buildUrl(word, accent) {
  const type = ACCENT_TYPE[accent] || ACCENT_TYPE.us

  return `${BASE_URL}?audio=${encodeURIComponent(word)}&type=${type}`
}

function getContext() {
  if (context) return context

  context = wx.createInnerAudioContext()
  // 手机静音时也出声，背单词场景下用户点了一般就是想听
  context.obeyMuteSwitch = false

  // 回调只在创建时挂一次，避免每次播放都叠加监听
  context.onError(error => {
    console.error('单词发音播放失败：', error)

    failures += 1

    if (failures > MAX_FAILURES) return

    wx.showToast({
      title: '发音加载失败，请检查网络',
      icon: 'none'
    })
  })

  return context
}

function play(word, accent) {
  if (!word) return

  if (failures > MAX_FAILURES) {
    wx.showToast({
      title: '当前环境无法播放发音',
      icon: 'none'
    })
    return
  }

  const player = getContext()

  player.stop()
  player.src = buildUrl(word, accent)
  player.play()
}

// 离开页面时释放，下次进来重新建
function destroy() {
  if (!context) return

  context.destroy()
  context = null
}

module.exports = {
  play,
  destroy
}
