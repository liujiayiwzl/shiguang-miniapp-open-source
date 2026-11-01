// 公开示例配置：请在自己的云开发环境中填写环境 ID。
// 不要将真实环境 ID 或密钥提交到公开仓库。
const words = require('./utils/word-progress')
const CLOUD_ENV_ID = 'YOUR_CLOUDBASE_ENV_ID'

App({
  onLaunch() {
    if (!wx.cloud || CLOUD_ENV_ID === 'YOUR_CLOUDBASE_ENV_ID') {
      console.warn('尚未配置云开发环境，请先阅读 README.md 的部署说明')
      return
    }
    wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true })
    words.syncNow()
  },
  onHide() {
    words.flushPending()
  }
})
