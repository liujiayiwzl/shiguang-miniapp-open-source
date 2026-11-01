
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

// 初始化云开发
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

// 获取数据库
const db = cloud.database()

// 允许使用的卡片主题
const themes = ['治愈', '有趣', '思考', '学习']

// 云函数入口
exports.main = async (event, context) => {
  try {
    // 获取真实微信用户身份
    const { OPENID } = cloud.getWXContext()

    if (!OPENID) {
      return {
        success: false,
        message: '无法确认用户身份'
      }
    }

    // 获取小程序提交的卡片
    const card = event && event.card

    if (!card) {
      return {
        success: false,
        message: '没有收到卡片数据'
      }
    }

    // 检查卡片主题
    if (!themes.includes(card.theme)) {
      return {
        success: false,
        message: '卡片主题不正确'
      }
    }

    // 检查文本字段
    if (
      typeof card.text !== 'string' ||
      typeof card.english !== 'string' ||
      typeof card.translation !== 'string'
    ) {
      return {
        success: false,
        message: '卡片字段类型错误'
      }
    }

    // 检查内容长度
    const text = card.text.trim()
    const english = card.english.trim()
    const translation = card.translation.trim()

    if (
      !text ||
      text.length > 500 ||
      english.length > 300 ||
      translation.length > 300
    ) {
      return {
        success: false,
        message: '卡片内容为空或过长'
      }
    }

    // 生成卡片业务ID
    const id = 'card_' +
      crypto.randomBytes(12).toString('hex')

    // 保存到cards数据库
    await db.collection('cards').add({
      data: {
        id: id,
        theme: card.theme,
        text: text,
        english: english,
        translation: translation,
        sourceType: 'preset',
        ownerOpenId: OPENID,
        visibility: 'private',
        status: 'pending',
        createdAt: db.serverDate()
      }
    })

    return {
      success: true,
      message: '卡片保存成功',
      id: id
    }

  } catch (error) {
    console.error('保存卡片失败：', error)

    return {
      success: false,
      message: '保存失败，请稍后重试'
    }
  }
}
