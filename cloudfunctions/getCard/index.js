const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const ID_RE = /^card_[a-zA-Z0-9_-]{1,64}$/
const TOKEN_RE = /^[0-9a-f]{32}$/

function tokenMatches(input, stored) {
  if (typeof input !== 'string' || typeof stored !== 'string' ||
      !TOKEN_RE.test(input) || !TOKEN_RE.test(stored)) return false
  return crypto.timingSafeEqual(Buffer.from(input, 'hex'), Buffer.from(stored, 'hex'))
}

exports.main = async (event) => {
  try {
    const cardId = event && event.id
    if (typeof cardId !== 'string' || !ID_RE.test(cardId)) {
      return { success: false, message: '卡片ID不正确' }
    }

    const { OPENID } = cloud.getWXContext()
    const result = await db.collection('cards').where({ id: cardId }).limit(1).get()
    const card = result.data && result.data[0]
    const isPublic = !!card && card.visibility === 'public' && card.status === 'approved'
    const isOwner = !!card && !!OPENID && !!card.ownerOpenId && card.ownerOpenId === OPENID
    const shareEligible = !!card && card.sourceType === 'ai' &&
      card.visibility === 'private' && card.status === 'pending'

    // 兼容已经生成的旧 AI 卡片：本人重新打开时补发一个随机分享口令。
    if (shareEligible && isOwner && !TOKEN_RE.test(card.shareToken || '')) {
      const newToken = crypto.randomBytes(16).toString('hex')
      await db.collection('cards').doc(card._id).update({
        data: { shareToken: newToken }
      })
      card.shareToken = newToken
    }

    // 私人卡片必须是本人访问，或携带该卡片的随机分享口令。
    // 不能凭卡片 ID 就读取其他人的私人作品。
    const sharedAccess = shareEligible && tokenMatches(
      event && event.shareToken,
      card && card.shareToken
    )

    if (!card || (!isPublic && !isOwner && !sharedAccess)) {
      return { success: false, message: '没有找到可访问的卡片' }
    }

    const tokenForViewer = shareEligible && (isOwner || sharedAccess)
      ? card.shareToken
      : ''

    return {
      success: true,
      data: {
        id: card.id,
        theme: card.theme || '随心',
        text: card.text || '',
        english: card.english || '',
        translation: card.translation || '',
        tags: Array.isArray(card.tags) ? card.tags.slice(0, 2) : [],
        sourceType: card.sourceType || 'preset',
        createdAt: card.createdAt || '',
        canShare: isPublic || !!tokenForViewer,
        shareToken: tokenForViewer
      }
    }
  } catch (error) {
    console.error('getCard错误：', error)
    return { success: false, message: '服务器出现错误' }
  }
}
