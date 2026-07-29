const crypto = require('crypto');
const axios = require('axios');
const db = require('./database');

function signPayload(secret, bodyString) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
}

async function dispatchEvent(eventName, payload) {
  const subs = db.getAllWebhookSubscriptions().filter(s => s.active && s.event === eventName);
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
      db.logWebhookTrigger(sub.id, `ok:${res.status}`);
    } catch (err) {
      db.logWebhookTrigger(sub.id, `fail:${err.code || err.message}`);
    }
  }));
}

function verifyInboundToken(token) {
  if (!token) return null;
  const rec = db.getWebhookTokenByValue(token);
  if (!rec || !rec.active) return null;
  return rec;
}

async function testSubscription(sub) {
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
    db.logWebhookTrigger(sub.id, `ok:${res.status}`);
    return { ok: true, status: res.status };
  } catch (err) {
    const statusText = `fail:${err.code || err.message}`;
    db.logWebhookTrigger(sub.id, statusText);
    return { ok: false, error: err.message };
  }
}

module.exports = { signPayload, dispatchEvent, verifyInboundToken, testSubscription };
