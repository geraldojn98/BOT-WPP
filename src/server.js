require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const db = require('./database');
const bot = require('./bot');
const webhooks = require('./webhooks');
const instagram = require('./instagram');
const { getProductInfo, generateAffiliateLink } = require('./mercadolivre');
const { setupMlSession, isSessionReady } = require('./mlAffiliate');
const { generateCustomMessage } = require('./claude');

const app = express();
const server = http.createServer(app);

// Tenta carregar socket.io (opcional)
let io = null;
try {
  const { Server } = require('socket.io');
  io = new Server(server);
  io.on('connection', (socket) => {
    socket.emit('status', bot.getStatus());
  });
} catch {}

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ===== WEBHOOK DE ENTRADA (sistemas externos → WhatsApp) =====
// Registrado ANTES do basic-auth do painel: autentica via token próprio (X-Webhook-Token),
// não deve depender de PANEL_USER/PANEL_PASS.
app.post('/api/inbound/send', async (req, res) => {
  try {
    const token = req.headers['x-webhook-token'];
    const rec = webhooks.verifyInboundToken(token);
    if (!rec) return res.status(401).json({ error: 'Token inválido ou inativo.' });
    db.touchWebhookTokenUsage(rec.id);
    const { to, text, imageUrl } = req.body;
    const result = await bot.sendInboundMessage({ to, text, imageUrl });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== WEBHOOK DO INSTAGRAM (Meta → nosso servidor) =====
// Registrado ANTES do basic-auth: a Meta chama essa rota diretamente, sem credenciais do painel.
app.get('/api/instagram/webhook', (req, res) => {
  const challenge = instagram.verifyWebhookChallenge(req.query);
  if (challenge !== null) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/api/instagram/webhook', (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!instagram.verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // responde rápido pra Meta, processa em background
  instagram.handleCommentWebhookEvent(req.body, bot.getActiveSeriesGroupLink, io).catch(err => {
    console.error('[Instagram] Erro ao processar webhook:', err.message);
  });
});

// ===== AUTENTICAÇÃO BÁSICA (ativa se PANEL_USER e PANEL_PASS estiverem definidos) =====
if (process.env.PANEL_USER && process.env.PANEL_PASS) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="ML Bot Panel"');
      return res.status(401).send('Login necessário');
    }
    const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    if (user !== process.env.PANEL_USER || pass !== process.env.PANEL_PASS) {
      res.setHeader('WWW-Authenticate', 'Basic realm="ML Bot Panel"');
      return res.status(401).send('Usuário ou senha inválidos');
    }
    next();
  });
  console.log('[Auth] Painel protegido com usuário e senha.');
}

app.use(express.static(path.join(__dirname, '../public')));

// ===== STATUS =====

app.get('/api/status', (req, res) => {
  res.json(bot.getStatus());
});

// ===== PRODUTOS =====

app.get('/api/products', (req, res) => {
  res.json(db.getAllProducts());
});

app.get('/api/products/:id', (req, res) => {
  const product = db.getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  res.json(product);
});

// Adicionar produto via URL do ML
app.post('/api/products/import', async (req, res) => {
  try {
    const { url, affiliateUrl } = req.body;
    if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

    const { customImageUrl } = req.body;
    const info = await getProductInfo(url);

    // Prioridade: link de afiliado manual > link já extraído > gerar automaticamente
    if (affiliateUrl) {
      info.affiliate_url = affiliateUrl;
    } else if (!info.affiliate_url) {
      info.affiliate_url = await generateAffiliateLink(info.url);
    }

    // Imagem personalizada sobrescreve a do ML
    if (customImageUrl) info.image_url = customImageUrl;

    const result = db.addProduct(info);
    res.json({ id: result.lastInsertRowid, ...info });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Adicionar produto manualmente
app.post('/api/products', (req, res) => {
  try {
    const product = req.body;
    if (!product.title || !product.url) {
      return res.status(400).json({ error: 'Título e URL são obrigatórios' });
    }
    const result = db.addProduct(product);
    res.json({ id: result.lastInsertRowid, ...product });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    db.updateProduct(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    db.deleteProduct(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE product]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/toggle', (req, res) => {
  const { active } = req.body;
  db.toggleProduct(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== GRUPOS WHATSAPP =====

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await bot.getGroups();
    res.json(groups);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/groups/:groupId', async (req, res) => {
  try {
    const result = await bot.leaveGroup(req.params.groupId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== HISTÓRICO =====

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.getPostHistory(limit));
});

// ===== POST AUTOMÁTICO (busca produto no ML e posta) =====
// DEVE VIR ANTES de /api/post/:id para o Express não confundir "auto" com um ID

app.post('/api/post/auto', async (req, res) => {
  try {
    const result = await bot.runAutoPost(io);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== POST MANUAL =====

app.post('/api/post/:id', async (req, res) => {
  try {
    const text = await bot.sendManualPost(req.params.id, io);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== DIAGNÓSTICO ML =====
app.get('/api/debug/ml', async (req, res) => {
  try {
    const axios = require('axios');
    const q = req.query.q || 'smartphone';
    const { data } = await axios.get(`https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(q)}&condition=new&limit=10`, {
      headers: process.env.ML_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` } : {},
      timeout: 10000,
    });
    const results = (data.results || []).map(i => ({
      id: i.id,
      title: i.title.slice(0, 60),
      price: i.price,
      original_price: i.original_price || null,
      discount: i.original_price ? Math.round(((i.original_price - i.price) / i.original_price) * 100) + '%' : '—',
    }));
    res.json({ total: data.paging?.total, q, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CONFIGURAÇÕES =====

app.get('/api/settings', (req, res) => {
  res.json(db.getAllSettings());
});

app.post('/api/settings', (req, res) => {
  const settings = req.body;
  for (const [key, value] of Object.entries(settings)) {
    db.setSetting(key, value);
  }
  bot.reloadCron(io);
  res.json({ ok: true });
});

// ===== AFILIADOS ML (sessão meli.la) =====

app.get('/api/ml-affiliate/status', (req, res) => {
  res.json({ ready: isSessionReady() });
});

app.post('/api/ml-affiliate/setup', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Abrindo navegador para login... Faça login no Mercado Livre na janela que abriu.' });
    // Roda em background — não bloqueia a resposta
    setupMlSession().then(() => {
      console.log('[Server] Sessão ML Affiliate configurada com sucesso.');
      if (io) io.emit('ml_affiliate_ready', { ready: true });
    }).catch(err => {
      console.error('[Server] Erro no setup ML Affiliate:', err.message);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== RECONEXÃO / DESCONEXÃO WHATSAPP =====

app.post('/api/reconnect', async (req, res) => {
  try {
    await bot.reconnectWhatsApp(io);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  try {
    await bot.disconnectWhatsApp(io);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== GERAR MENSAGEM (PREVIEW SEM ENVIAR) =====

app.post('/api/generate-message', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt é obrigatório' });
    const now = new Date();
    const dayNames = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
    const text = await generateCustomMessage(prompt, {
      date: now.toLocaleDateString('pt-BR'),
      dayName: dayNames[now.getDay()],
    });
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== BROADCAST =====

app.post('/api/broadcast', async (req, res) => {
  try {
    const { text } = req.body;
    const result = await bot.broadcastMessage(text, io);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== HISTÓRICO =====

app.delete('/api/history', (req, res) => {
  try {
    db.clearHistory();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AFILIADO ML — DESCONECTAR =====

app.delete('/api/ml-affiliate/session', (req, res) => {
  try {
    const sessionDir = path.join(__dirname, '../data/ml-session');
    if (require('fs').existsSync(sessionDir)) {
      require('fs').rmSync(sessionDir, { recursive: true, force: true });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MENSAGENS AGENDADAS =====

app.get('/api/scheduled-messages', (req, res) => {
  res.json(db.getAllScheduledMessages());
});

app.get('/api/scheduled-messages/:id', (req, res) => {
  const msg = db.getScheduledMessageById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Não encontrado' });
  res.json(msg);
});

app.post('/api/scheduled-messages', (req, res) => {
  try {
    const result = db.addScheduledMessage(req.body);
    res.json({ id: result.lastInsertRowid, ...req.body });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/scheduled-messages/:id', (req, res) => {
  try {
    db.updateScheduledMessage(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/scheduled-messages/:id', (req, res) => {
  try {
    db.deleteScheduledMessage(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/scheduled-messages/:id/toggle', (req, res) => {
  try {
    const { active } = req.body;
    db.toggleScheduledMessage(req.params.id, active ? 1 : 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem personalizada agora (manual ou IA) para grupos específicos
app.post('/api/broadcast/custom', async (req, res) => {
  try {
    const { text, groupIds, type, prompt } = req.body;
    let finalText = text || '';
    if (type === 'ai' && prompt) {
      const now = new Date();
      const dayNames = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
      finalText = await generateCustomMessage(prompt, {
        date: now.toLocaleDateString('pt-BR'),
        dayName: dayNames[now.getDay()],
      });
    }
    const ids = (groupIds || []).filter(id => id && id !== '__preview__');
    // If preview only (no real groups), just return the generated text
    if (!ids.length) return res.json({ ok: true, text: finalText, groups: 0 });
    const result = await bot.broadcastToGroups(finalText, ids);
    res.json({ ok: true, text: finalText, groups: result.groups });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== RESPOSTAS AUTOMÁTICAS =====

app.get('/api/auto-reply-rules', (req, res) => {
  res.json(db.getAllAutoReplyRules());
});

app.get('/api/auto-reply-rules/:id', (req, res) => {
  const rule = db.getAutoReplyRuleById(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
  res.json(rule);
});

app.post('/api/auto-reply-rules', (req, res) => {
  try {
    const rule = req.body;
    if (!rule.name || !rule.keywords) return res.status(400).json({ error: 'Nome e palavras-chave são obrigatórios' });
    const result = db.addAutoReplyRule(rule);
    res.json({ id: result.lastInsertRowid, ...rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/auto-reply-rules/:id', (req, res) => {
  try {
    db.updateAutoReplyRule(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/auto-reply-rules/:id', (req, res) => {
  try {
    db.deleteAutoReplyRule(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/auto-reply-rules/:id/toggle', (req, res) => {
  const { active } = req.body;
  db.toggleAutoReplyRule(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== GESTÃO DE GRUPOS =====

app.get('/api/group-settings', (req, res) => {
  res.json(db.getAllGroupSettings());
});

app.get('/api/group-settings/:groupId', (req, res) => {
  res.json(db.getGroupSettings(req.params.groupId));
});

app.put('/api/group-settings/:groupId', (req, res) => {
  try {
    db.upsertGroupSettings(req.params.groupId, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== INTEGRAÇÕES — WEBHOOKS DE SAÍDA =====

app.get('/api/webhooks', (req, res) => {
  res.json(db.getAllWebhookSubscriptions());
});

app.post('/api/webhooks', (req, res) => {
  try {
    const sub = req.body;
    if (!sub.name || !sub.url) return res.status(400).json({ error: 'Nome e URL são obrigatórios' });
    if (!sub.secret) sub.secret = crypto.randomBytes(24).toString('hex');
    const result = db.addWebhookSubscription(sub);
    res.json({ id: result.lastInsertRowid, ...sub });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/webhooks/:id', (req, res) => {
  try {
    db.updateWebhookSubscription(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/webhooks/:id', (req, res) => {
  try {
    db.deleteWebhookSubscription(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/webhooks/:id/toggle', (req, res) => {
  const { active } = req.body;
  db.toggleWebhookSubscription(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

app.post('/api/webhooks/:id/test', async (req, res) => {
  try {
    const sub = db.getWebhookSubscriptionById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada' });
    const result = await webhooks.testSubscription(sub);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== INTEGRAÇÕES — TOKENS DE ENTRADA =====

app.get('/api/webhook-tokens', (req, res) => {
  res.json(db.getAllWebhookTokens());
});

app.post('/api/webhook-tokens', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    const token = crypto.randomBytes(24).toString('hex');
    const result = db.addWebhookToken(name, token);
    res.json({ id: result.lastInsertRowid, name, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/webhook-tokens/:id', (req, res) => {
  try {
    db.deleteWebhookToken(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/webhook-tokens/:id/toggle', (req, res) => {
  const { active } = req.body;
  db.toggleWebhookToken(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== CAMPANHAS =====

app.get('/api/campaigns', (req, res) => {
  res.json(db.getAllCampaigns());
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaign = db.getCampaignById(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
  res.json({ ...campaign, recipients: db.getCampaignRecipients(campaign.id) });
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, message_text, image_url, target_type, contact_source, delay_min_seconds, delay_max_seconds, targets } = req.body;
    if (!name || !message_text) return res.status(400).json({ error: 'Nome e mensagem são obrigatórios' });
    if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'Selecione ao menos um destinatário' });

    const campaign = {
      name, message_text, ai_prompt: null, image_url: image_url || null,
      target_type: target_type === 'contacts' ? 'contacts' : 'groups',
      contact_source: contact_source === 'any' ? 'any' : 'known_only',
      delay_min_seconds: parseInt(delay_min_seconds) || 8,
      delay_max_seconds: Math.max(parseInt(delay_max_seconds) || 20, parseInt(delay_min_seconds) || 8),
      status: 'draft',
    };
    const result = db.addCampaign(campaign);
    const campaignId = result.lastInsertRowid;

    let recipients = targets.map(t => ({ id: t.id, name: t.name || null, status: 'pending' }));
    if (campaign.target_type === 'contacts' && campaign.contact_source === 'known_only') {
      const known = await bot.getKnownContactIds();
      recipients = recipients.map(r => {
        const normalized = bot.normalizeWhatsAppId(r.id);
        return known.has(normalized)
          ? { ...r, id: normalized, status: 'pending' }
          : { ...r, id: normalized, status: 'skipped', error: 'Número não é um contato conhecido pela conta conectada.' };
      });
    } else if (campaign.target_type === 'contacts') {
      recipients = recipients.map(r => ({ ...r, id: bot.normalizeWhatsAppId(r.id) }));
    }

    db.addCampaignRecipients(campaignId, recipients);
    res.json({ id: campaignId, ...campaign });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id', (req, res) => {
  try {
    db.deleteCampaign(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/start', (req, res) => {
  try {
    res.json(bot.startCampaign(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  try {
    res.json(bot.pauseCampaign(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/resume', (req, res) => {
  try {
    res.json(bot.startCampaign(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/cancel', (req, res) => {
  try {
    res.json(bot.cancelCampaign(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/progress', (req, res) => {
  try {
    res.json(db.getCampaignProgress(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DIRETÓRIO PRÓPRIO DE GRUPOS CONHECIDOS =====

app.get('/api/known-groups', (req, res) => {
  res.json(db.getAllKnownGroups());
});

app.post('/api/known-groups', (req, res) => {
  try {
    const { groupId } = req.body;
    if (!groupId || !groupId.endsWith('@g.us')) return res.status(400).json({ error: 'ID de grupo inválido (precisa terminar com @g.us)' });
    db.addManualKnownGroup(groupId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/known-groups/:groupId/nickname', (req, res) => {
  try {
    const { nickname } = req.body;
    db.setKnownGroupNickname(req.params.groupId, nickname || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/known-groups/:groupId', (req, res) => {
  try {
    db.deleteKnownGroup(req.params.groupId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTO-ESCALA DE GRUPOS (SÉRIE) =====

app.get('/api/group-series', (req, res) => {
  res.json(db.getAllGroupSeries());
});

app.get('/api/group-series/:id', async (req, res) => {
  try {
    const detail = await bot.getGroupSeriesDetail(req.params.id);
    res.json(detail);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/group-series', async (req, res) => {
  try {
    const { name, member_threshold, groupId } = req.body;
    const result = await bot.createGroupSeries({ name, member_threshold: parseInt(member_threshold) || 1000, groupId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/group-series/:id', (req, res) => {
  try {
    db.deleteGroupSeries(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/group-series/:id', (req, res) => {
  try {
    const existing = db.getGroupSeriesById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Série não encontrada' });
    const { name, member_threshold, active } = req.body;
    db.updateGroupSeries(req.params.id, {
      name: name ?? existing.name,
      member_threshold: parseInt(member_threshold) || existing.member_threshold,
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== INSTAGRAM: STATUS E REGRAS DE COMENTÁRIO =====

app.get('/api/instagram/status', (req, res) => {
  res.json({ configured: instagram.isConfigured(), env: instagram.getConfigStatus() });
});

app.get('/api/instagram-comment-rules', (req, res) => {
  res.json(db.getAllInstagramCommentRules());
});

app.get('/api/instagram-comment-rules/:id', (req, res) => {
  const rule = db.getInstagramCommentRuleById(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
  res.json(rule);
});

app.post('/api/instagram-comment-rules', (req, res) => {
  try {
    const rule = req.body;
    if (!rule.name || !rule.keywords) return res.status(400).json({ error: 'Nome e palavras-chave são obrigatórios' });
    if (!rule.reply_text) return res.status(400).json({ error: 'Texto da resposta é obrigatório' });
    const result = db.addInstagramCommentRule(rule);
    res.json({ id: result.lastInsertRowid, ...rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/instagram-comment-rules/:id', (req, res) => {
  try {
    db.updateInstagramCommentRule(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/instagram-comment-rules/:id', (req, res) => {
  try {
    db.deleteInstagramCommentRule(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/instagram-comment-rules/:id/toggle', (req, res) => {
  const { active } = req.body;
  db.toggleInstagramCommentRule(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== INICIALIZACAO =====

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n  ML WhatsApp Bot rodando em http://localhost:' + PORT + '\n');
  bot.initWhatsApp(io).catch(err => console.error('[Bot] Falha ao iniciar WhatsApp:', err.message));
});
