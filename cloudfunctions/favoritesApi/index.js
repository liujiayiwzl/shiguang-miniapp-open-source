const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const ID_RE = /^card_[a-zA-Z0-9_-]{1,64}$/
const TOKEN_RE = /^[0-9a-f]{32}$/

function favoriteId(openid, cardId) {
  return 'fav_' + crypto.createHash('sha256')
    .update(openid + ':' + cardId).digest('hex').slice(0, 32)
}

function tokenMatches(input, stored) {
  if (typeof input !== 'string' || typeof stored !== 'string' ||
      !TOKEN_RE.test(input) || !TOKEN_RE.test(stored)) return false
  return crypto.timingSafeEqual(Buffer.from(input, 'hex'), Buffer.from(stored, 'hex'))
}

function canAccess(card, openid, shareToken) {
  if (!card) return false
  return (card.visibility === 'public' && card.status === 'approved') ||
    (!!card.ownerOpenId && card.ownerOpenId === openid) ||
    (card.sourceType === 'ai' && card.visibility === 'private' &&
      card.status === 'pending' && tokenMatches(shareToken, card.shareToken))
}

function formatCard(card) {
  return {
    id: card.id,
    theme: card.theme || '随心',
    text: card.text || '',
    english: card.english || '',
    translation: card.translation || '',
    tags: Array.isArray(card.tags) ? card.tags.slice(0, 2) : [],
    sourceType: card.sourceType || 'preset',
    createdAt: card.createdAt || '',
    canShare: card.visibility === 'public' && card.status === 'approved'
  }
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID) return { success: false, message: '无法确认用户身份' }

    const action = event && event.action
    const favorites = db.collection('favorites')

    if (action === 'list') {
      const saved = await favorites.where({ userOpenId: OPENID })
        .orderBy('createdAt', 'desc').limit(50).get()
      const ids = [...new Set(saved.data.map(item => item.cardId).filter(id => ID_RE.test(id)))]
      if (!ids.length) return { success: true, data: [] }

      const result = await db.collection('cards').where({ id: _.in(ids) }).limit(100).get()
      const cardMap = new Map(result.data.map(card => [card.id, card]))

      return {
        success: true,
        data: saved.data
          .filter(item => ID_RE.test(item.cardId))
          .map(item => ({ card: cardMap.get(item.cardId), token: item.shareToken }))
          .filter(item => canAccess(item.card, OPENID, item.token))
          .map(item => formatCard(item.card))
      }
    }

    const cardId = event && event.cardId
    if (!['add', 'remove'].includes(action) || typeof cardId !== 'string' ||
        !ID_RE.test(cardId)) {
      return { success: false, message: '操作参数不正确' }
    }

    const id = favoriteId(OPENID, cardId)
    if (action === 'remove') {
      await favorites.doc(id).remove()
      return { success: true, message: '已取消收藏' }
    }

    const matches = await db.collection('cards').where({ id: cardId }).limit(1).get()
    const card = matches.data && matches.data[0]
    const suppliedToken = event && event.shareToken
    if (!canAccess(card, OPENID, suppliedToken)) {
      return { success: false, message: '这张卡片暂时不能收藏' }
    }

    // 只有通过分享口令访问私人 AI 卡片时，才在自己的收藏中保存口令。
    const isPublic = card.visibility === 'public' && card.status === 'approved'
    const isOwner = !!card.ownerOpenId && card.ownerOpenId === OPENID
    const tokenForFavorite = !isPublic && !isOwner &&
      tokenMatches(suppliedToken, card.shareToken) ? suppliedToken : ''

    await favorites.doc(id).set({
      data: {
        userOpenId: OPENID,
        cardId,
        shareToken: tokenForFavorite,
        createdAt: db.serverDate()
      }
    })
    return { success: true, message: '收藏成功' }
  } catch (error) {
    console.error('favoritesApi错误：', error)
    return { success: false, message: '操作失败，请稍后重试' }
  }
}
