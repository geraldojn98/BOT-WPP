const crypto = require('crypto');
const axios = require('axios');
const db = require('./database');

function signPayload(secret, bodyString) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
}

// userDb: banco do usuário dono das assinaturas (db.getUserDb(userId)) — cada
// usuário só recebe notificação das próprias assinaturas de webhook.
async function dispatchEvent(userDb, eventName, payload) {
  const subs = userDb.getAllWebhookSubscriptions().filter(s => s.active && s.event === eventName);
  if (!subs.length) return;

  const bodyString = JSON.stringify({ event: eventName, data: payload, sentAt: new Date().toISOString() });

  await Promise.allSettled(subs.map(async (sub) => {
    try {
      const signature = signPayload(sub.secret, bodyString);
      const res = await axios.post(sub.url, bodyString, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': eventName,
          'X-Webhook-Signature': `sha256=${signature}`,
        },
        timeout: 10000,
      });
      userDb.logWebhookTrigger(sub.id, `ok:${res.status}`);
    } catch (err) {
      userDb.logWebhookTrigger(sub.id, `fail:${err.code || err.message}`);
    }
  }));
}

// Tokens de entrada são globais (precisam ser buscáveis só pelo valor do token,
// antes de saber de qual usuário é) — retorna { id, user_id, name, token, active }.
function verifyInboundToken(token) {
  if (!token) return null;
  const rec = db.getWebhookTokenByValue(token);
  if (!rec || !rec.active) return null;
  return rec;
}

async function testSubscription(userDb, sub) {
  const bodyString = JSON.stringify({ event: sub.event, data: { test: true }, sentAt: new Date().toISOString() });
  try {
    const signature = signPayload(sub.secret, bodyString);
    const res = await axios.post(sub.url, bodyString, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': sub.event,
        'X-Webhook-Signature': `sha256=${signature}`,
      },
      timeout: 10000,
    });
    userDb.logWebhookTrigger(sub.id, `ok:${res.status}`);
    return { ok: true, status: res.status };
  } catch (err) {
    const statusText = `fail:${err.code || err.message}`;
    userDb.logWebhookTrigger(sub.id, statusText);
    return { ok: false, error: err.message };
  }
}

module.exports = { signPayload, dispatchEvent, verifyInboundToken, testSubscription };
