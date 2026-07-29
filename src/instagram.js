const crypto = require('crypto');
const axios = require('axios');
const db = require('./database');

const GRAPH_VERSION = 'v21.0';

function getConfigStatus() {
  return {
    pageId: !!process.env.INSTAGRAM_PAGE_ID,
    pageAccessToken: !!process.env.INSTAGRAM_PAGE_ACCESS_TOKEN,
    appSecret: !!process.env.INSTAGRAM_APP_SECRET,
    webhookVerifyToken: !!process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
  };
}

function isConfigured() {
  const s = getConfigStatus();
  return s.pageId && s.pageAccessToken && s.appSecret && s.webhookVerifyToken;
}

function verifyWebhookChallenge(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !process.env.INSTAGRAM_APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (_) {
    return false;
  }
}

function matchesCommentRule(rule, text) {
  const raw = text || '';
  const body = rule.case_sensitive ? raw : raw.toLowerCase();
  const keywords = (rule.keywords || '').split(',').map(k => k.trim()).filter(Boolean)
    .map(k => rule.case_sensitive ? k : k.toLowerCase());
  if (!keywords.length) return false;
  const test = (kw) => {
    if (rule.trigger_type === 'exact') return body === kw;
    if (rule.trigger_type === 'starts_with') return body.startsWith(kw);
    return body.includes(kw);
  };
  return rule.match_mode === 'all' ? keywords.every(test) : keywords.some(test);
}

async function sendPrivateReply(commentId, text) {
  const pageId = process.env.INSTAGRAM_PAGE_ID;
  const token = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) throw new Error('Instagram não configurado (variáveis de ambiente ausentes).');

  const res = await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/messages`, {
    recipient: { comment_id: commentId },
    message: { text },
  }, {
    params: { access_token: token },
    timeout: 10000,
  });
  return res.data;
}

async function handleCommentWebhookEvent(payload, resolveGroupLink, io) {
  const entries = payload?.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== 'comments') continue;
      const value = change.value || {};
      const commentId = value.id;
      const text = value.text || '';
      const mediaId = value.media?.id || '';
      if (!commentId) continue;
      if (db.wasCommentAlreadyReplied(commentId)) continue;

      try {
        await processComment({ commentId, text, mediaId }, resolveGroupLink, io);
      } catch (err) {
        console.error('[Instagram] Erro ao processar comentário:', err.message);
      }
    }
  }
}

async function processComment({ commentId, text, mediaId }, resolveGroupLink, io) {
  const rules = db.getActiveInstagramCommentRules();
  for (const rule of rules) {
    if (rule.media_id && rule.media_id !== mediaId) continue;
    if (!matchesCommentRule(rule, text)) continue;

    let replyText = rule.reply_text || '';
    if (replyText.includes('{group_link}')) {
      const link = await resolveGroupLink(rule.series_id);
      if (!link) {
        console.log(`[Instagram] Regra "${rule.name}" combinou, mas não há link de grupo ativo pra série ${rule.series_id}.`);
        continue;
      }
      replyText = replyText.replace(/\{group_link\}/g, link);
    }
    if (!replyText.trim()) continue;

    await sendPrivateReply(commentId, replyText.trim());
    db.logCommentReplied(commentId, rule.id);
    console.log(`[Instagram] ✅ Regra "${rule.name}" respondeu ao comentário ${commentId}`);
    if (io) io.emit('instagram_reply_sent', { rule: rule.name, commentId });
    break; // uma resposta por comentário — a própria Meta só permite isso mesmo
  }
}

module.exports = {
  getConfigStatus, isConfigured,
  verifyWebhookChallenge, verifySignature,
  matchesCommentRule, sendPrivateReply,
  handleCommentWebhookEvent,
};
