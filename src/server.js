require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const db = require('./database');
const bot = require('./bot');
const auth = require('./auth');
const webhooks = require('./webhooks');
const instagram = require('./instagram');
const { getProductInfo, generateAffiliateLink } = require('./mercadolivre');
const { setupMlSession, isSessionReady, migrateLegacyMlSession } = require('./mlAffiliate');
const { generateCustomMessage } = require('./claude');

const app = express();
// Railway roda atrás de um proxy — sem isso, req.ip retorna o IP do proxy pra
// todo mundo, e o rate-limit de login/cadastro passaria a valer pra TODOS os
// usuários juntos em vez de por pessoa.
app.set('trust proxy', true);
const server = http.createServer(app);

// A automação de Instagram ainda não foi adaptada pro modelo multiusuário (a
// configuração do app da Meta é global, via variáveis de ambiente) — fica
// vinculada ao usuário criado a partir de PANEL_USER, resolvido uma vez e
// cacheado (não muda em runtime).
let _adminUserCache;
function getAdminUser() {
  if (_adminUserCache !== undefined) return _adminUserCache;
  _adminUserCache = process.env.PANEL_USER ? (db.getUserByUsername(process.env.PANEL_USER) || null) : null;
  return _adminUserCache;
}

// Tenta carregar socket.io (opcional)
let io = null;
try {
  const { Server } = require('socket.io');
  io = new Server(server);
  // Cada socket só entra na "sala" do próprio usuário (identificado pelo cookie
  // de sessão do handshake) — sem isso, io.emit() mandaria eventos de um
  // usuário (status do WhatsApp, posts enviados...) pra tela de todo mundo.
  io.on('connection', (socket) => {
    const cookieHeader = socket.handshake.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`${auth.COOKIE_NAME}=([^;]+)`));
    const token = match ? decodeURIComponent(match[1]) : null;
    const user = db.getSessionUser(token);
    if (!user) { socket.disconnect(true); return; }
    socket.join(`user:${user.id}`);
    socket.emit('status', bot.getStatus(user.id));
  });
} catch {}

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// ===== WEBHOOK DE ENTRADA (sistemas externos → WhatsApp) =====
// Registrado ANTES do login do painel: autentica via token próprio (X-Webhook-Token),
// não depende de sessão de usuário — o próprio token já identifica de qual usuário é.
app.post('/api/inbound/send', async (req, res) => {
  try {
    const token = req.headers['x-webhook-token'];
    const rec = webhooks.verifyInboundToken(token);
    if (!rec) return res.status(401).json({ error: 'Token inválido ou inativo.' });
    db.touchWebhookTokenUsage(rec.id);
    const { to, text, imageUrl } = req.body;
    const result = await bot.sendInboundMessage(rec.user_id, { to, text, imageUrl });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== WEBHOOK DO INSTAGRAM (Meta → nosso servidor) =====
// Registrado ANTES do login: a Meta chama essa rota diretamente, sem credenciais do painel.
// OBS: a automação de Instagram ainda não foi adaptada pro modelo multiusuário — continua
// operando sobre a conta configurada globalmente via variáveis de ambiente (INSTAGRAM_*).
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
  const admin = getAdminUser();
  if (!admin) return; // sem PANEL_USER configurado, não tem em qual usuário registrar a regra
  const userDb = db.getUserDb(admin.id);
  instagram.handleCommentWebhookEvent(userDb, req.body, (seriesId) => bot.getActiveSeriesGroupLink(admin.id, seriesId), io).catch(err => {
    console.error('[Instagram] Erro ao processar webhook:', err.message);
  });
});

// ===== LOGIN (cada usuário tem sua própria conta, com seu próprio WhatsApp) =====
// Assets estáticos (login.html, ícones, manifest, css/js) ficam públicos — só o
// próprio painel (index.html) e as rotas /api/* exigem sessão válida.
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

app.post('/api/auth/signup', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (!auth.checkRateLimit('signup:' + ip)) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  try {
    const { username, password } = req.body;
    const user = auth.signup(username, password);
    const token = db.createSession(user.id);
    auth.setSessionCookie(res, token);
    res.json({ ok: true, username: user.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (!auth.checkRateLimit('login:' + ip)) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  try {
    const { username, password } = req.body;
    const user = auth.login(username, password);
    const token = db.createSession(user.id);
    auth.setSessionCookie(res, token);
    res.json({ ok: true, username: user.username });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  if (token) db.deleteSession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  const user = db.getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  res.json({ username: user.username });
});

app.get('/', auth.requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/index.html', auth.requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use('/api', auth.requireAuthApi);

// ===== STATUS =====

app.get('/api/status', (req, res) => {
  res.json(bot.getStatus(req.userId));
});

// ===== PRODUTOS =====

app.get('/api/products', (req, res) => {
  res.json(req.userDb.getAllProducts());
});

app.get('/api/products/:id', (req, res) => {
  const product = req.userDb.getProductById(req.params.id);
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

    const result = req.userDb.addProduct(info);
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
    const result = req.userDb.addProduct(product);
    res.json({ id: result.lastInsertRowid, ...product });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    req.userDb.updateProduct(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    req.userDb.deleteProduct(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE product]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/toggle', (req, res) => {
  const { active } = req.body;
  req.userDb.toggleProduct(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== GRUPOS WHATSAPP =====

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await bot.getGroups(req.userId);
    res.json(groups);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/groups/:groupId', async (req, res) => {
  try {
    const result = await bot.leaveGroup(req.userId, req.params.groupId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== HISTÓRICO =====

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(req.userDb.getPostHistory(limit));
});

// ===== HISTÓRICO LOG (eventos/erros do robô) =====

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const level = req.query.level || null;
  res.json(req.userDb.getLogs(limit, level));
});

app.delete('/api/logs', (req, res) => {
  req.userDb.clearLogs();
  res.json({ ok: true });
});

// ===== POST MANUAL =====

app.post('/api/post/:id', async (req, res) => {
  try {
    const text = await bot.sendManualPost(req.userId, req.params.id, req.body?.profileId || null, io);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== PERFIS DE POSTAGEM =====

app.get('/api/post-profiles', (req, res) => {
  res.json(req.userDb.getAllPostProfiles());
});

app.get('/api/post-profiles/:id', (req, res) => {
  const profile = req.userDb.getPostProfileById(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Perfil não encontrado.' });
  res.json(profile);
});

app.post('/api/post-profiles', (req, res) => {
  try {
    const result = req.userDb.addPostProfile(req.body);
    bot.reloadCron(req.userId, io);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/post-profiles/:id', (req, res) => {
  try {
    req.userDb.updatePostProfile(req.params.id, req.body);
    bot.reloadCron(req.userId, io);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/post-profiles/:id', (req, res) => {
  req.userDb.deletePostProfile(req.params.id);
  bot.reloadCron(req.userId, io);
  res.json({ ok: true });
});

app.patch('/api/post-profiles/:id/toggle', (req, res) => {
  req.userDb.togglePostProfile(req.params.id, req.body.active);
  bot.reloadCron(req.userId, io);
  res.json({ ok: true });
});

app.post('/api/post-profiles/:id/post-now', async (req, res) => {
  try {
    const result = await bot.runAutoPost(req.userId, io, req.params.id);
    res.json(result);
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
  res.json(req.userDb.getAllSettings());
});

app.post('/api/settings', (req, res) => {
  const settings = req.body;
  for (const [key, value] of Object.entries(settings)) {
    req.userDb.setSetting(key, value);
  }
  bot.reloadCron(req.userId, io);
  res.json({ ok: true });
});

// ===== AFILIADOS ML (sessão meli.la) =====
app.get('/api/ml-affiliate/status', (req, res) => {
  res.json({ ready: isSessionReady(req.userId) });
});

app.post('/api/ml-affiliate/setup', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Abrindo navegador para login... Faça login no Mercado Livre na janela que abriu.' });
    // Roda em background — não bloqueia a resposta
    setupMlSession(req.userId).then(() => {
      console.log('[Server] Sessão ML Affiliate configurada com sucesso.');
      if (io) io.to(`user:${req.userId}`).emit('ml_affiliate_ready', { ready: true });
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
    await bot.reconnectWhatsApp(req.userId, io);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  try {
    await bot.disconnectWhatsApp(req.userId, io);
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
    const result = await bot.broadcastMessage(req.userId, text, io);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== HISTÓRICO =====

app.delete('/api/history', (req, res) => {
  try {
    req.userDb.clearHistory();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AFILIADO ML — DESCONECTAR =====

app.delete('/api/ml-affiliate/session', (req, res) => {
  try {
    const fs = require('fs');
    const sessionDir = path.join(__dirname, '../data/ml-session', String(req.userId));
    const cookiesFile = path.join(__dirname, '../data', `ml-cookies-${req.userId}.json`);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    if (fs.existsSync(cookiesFile)) fs.rmSync(cookiesFile, { force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MENSAGENS AGENDADAS =====

app.get('/api/scheduled-messages', (req, res) => {
  res.json(req.userDb.getAllScheduledMessages());
});

app.get('/api/scheduled-messages/:id', (req, res) => {
  const msg = req.userDb.getScheduledMessageById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Não encontrado' });
  res.json(msg);
});

app.post('/api/scheduled-messages', (req, res) => {
  try {
    const result = req.userDb.addScheduledMessage(req.body);
    res.json({ id: result.lastInsertRowid, ...req.body });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/scheduled-messages/:id', (req, res) => {
  try {
    req.userDb.updateScheduledMessage(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/scheduled-messages/:id', (req, res) => {
  try {
    req.userDb.deleteScheduledMessage(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/scheduled-messages/:id/toggle', (req, res) => {
  try {
    const { active } = req.body;
    req.userDb.toggleScheduledMessage(req.params.id, active ? 1 : 0);
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
    const result = await bot.broadcastToGroups(req.userId, finalText, ids);
    res.json({ ok: true, text: finalText, groups: result.groups });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== RESPOSTAS AUTOMÁTICAS =====

app.get('/api/auto-reply-rules', (req, res) => {
  res.json(req.userDb.getAllAutoReplyRules());
});

app.get('/api/auto-reply-rules/:id', (req, res) => {
  const rule = req.userDb.getAutoReplyRuleById(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
  res.json(rule);
});

app.post('/api/auto-reply-rules', (req, res) => {
  try {
    const rule = req.body;
    if (!rule.name || !rule.keywords) return res.status(400).json({ error: 'Nome e palavras-chave são obrigatórios' });
    const result = req.userDb.addAutoReplyRule(rule);
    res.json({ id: result.lastInsertRowid, ...rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/auto-reply-rules/:id', (req, res) => {
  try {
    req.userDb.updateAutoReplyRule(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/auto-reply-rules/:id', (req, res) => {
  try {
    req.userDb.deleteAutoReplyRule(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/auto-reply-rules/:id/toggle', (req, res) => {
  const { active } = req.body;
  req.userDb.toggleAutoReplyRule(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== GESTÃO DE GRUPOS =====

app.get('/api/group-settings', (req, res) => {
  res.json(req.userDb.getAllGroupSettings());
});

app.get('/api/group-settings/:groupId', (req, res) => {
  res.json(req.userDb.getGroupSettings(req.params.groupId));
});

app.put('/api/group-settings/:groupId', (req, res) => {
  try {
    req.userDb.upsertGroupSettings(req.params.groupId, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== INTEGRAÇÕES — WEBHOOKS DE SAÍDA =====

app.get('/api/webhooks', (req, res) => {
  res.json(req.userDb.getAllWebhookSubscriptions());
});

app.post('/api/webhooks', (req, res) => {
  try {
    const sub = req.body;
    if (!sub.name || !sub.url) return res.status(400).json({ error: 'Nome e URL são obrigatórios' });
    if (!sub.secret) sub.secret = crypto.randomBytes(24).toString('hex');
    const result = req.userDb.addWebhookSubscription(sub);
    res.json({ id: result.lastInsertRowid, ...sub });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/webhooks/:id', (req, res) => {
  try {
    req.userDb.updateWebhookSubscription(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/webhooks/:id', (req, res) => {
  try {
    req.userDb.deleteWebhookSubscription(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/webhooks/:id/toggle', (req, res) => {
  const { active } = req.body;
  req.userDb.toggleWebhookSubscription(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

app.post('/api/webhooks/:id/test', async (req, res) => {
  try {
    const sub = req.userDb.getWebhookSubscriptionById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada' });
    const result = await webhooks.testSubscription(req.userDb, sub);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== INTEGRAÇÕES — TOKENS DE ENTRADA =====
// Tokens ficam num banco global (precisam ser buscáveis só pelo valor do
// token, antes de saber de qual usuário é) — mas cada usuário só vê/gerencia
// os próprios, filtrados por req.userId.

app.get('/api/webhook-tokens', (req, res) => {
  res.json(db.getAllWebhookTokensForUser(req.userId));
});

app.post('/api/webhook-tokens', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    const token = crypto.randomBytes(24).toString('hex');
    const result = db.addWebhookToken(req.userId, name, token);
    res.json({ id: result.lastInsertRowid, name, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/webhook-tokens/:id', (req, res) => {
  try {
    const tok = db.getWebhookTokenById(req.params.id);
    if (!tok || tok.user_id !== req.userId) return res.status(404).json({ error: 'Token não encontrado' });
    db.deleteWebhookToken(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/webhook-tokens/:id/toggle', (req, res) => {
  const tok = db.getWebhookTokenById(req.params.id);
  if (!tok || tok.user_id !== req.userId) return res.status(404).json({ error: 'Token não encontrado' });
  const { active } = req.body;
  db.toggleWebhookToken(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== CAMPANHAS =====

app.get('/api/campaigns', (req, res) => {
  res.json(req.userDb.getAllCampaigns());
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaign = req.userDb.getCampaignById(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
  res.json({ ...campaign, recipients: req.userDb.getCampaignRecipients(campaign.id) });
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
    const result = req.userDb.addCampaign(campaign);
    const campaignId = result.lastInsertRowid;

    let recipients = targets.map(t => ({ id: t.id, name: t.name || null, status: 'pending' }));
    if (campaign.target_type === 'contacts' && campaign.contact_source === 'known_only') {
      const known = await bot.getKnownContactIds(req.userId);
      recipients = recipients.map(r => {
        const normalized = bot.normalizeWhatsAppId(r.id);
        return known.has(normalized)
          ? { ...r, id: normalized, status: 'pending' }
          : { ...r, id: normalized, status: 'skipped', error: 'Número não é um contato conhecido pela conta conectada.' };
      });
    } else if (campaign.target_type === 'contacts') {
      recipients = recipients.map(r => ({ ...r, id: bot.normalizeWhatsAppId(r.id) }));
    }

    req.userDb.addCampaignRecipients(campaignId, recipients);
    res.json({ id: campaignId, ...campaign });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id', (req, res) => {
  try {
    req.userDb.deleteCampaign(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/start', (req, res) => {
  try {
    res.json(bot.startCampaign(req.userId, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  try {
    res.json(bot.pauseCampaign(req.userId, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/resume', (req, res) => {
  try {
    res.json(bot.startCampaign(req.userId, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/cancel', (req, res) => {
  try {
    res.json(bot.cancelCampaign(req.userId, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/progress', (req, res) => {
  try {
    res.json(req.userDb.getCampaignProgress(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DIRETÓRIO PRÓPRIO DE GRUPOS CONHECIDOS =====

app.get('/api/known-groups', (req, res) => {
  res.json(req.userDb.getAllKnownGroups());
});

app.post('/api/known-groups', (req, res) => {
  try {
    const { groupId } = req.body;
    if (!groupId || !groupId.endsWith('@g.us')) return res.status(400).json({ error: 'ID de grupo inválido (precisa terminar com @g.us)' });
    req.userDb.addManualKnownGroup(groupId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/known-groups/:groupId/nickname', (req, res) => {
  try {
    const { nickname } = req.body;
    req.userDb.setKnownGroupNickname(req.params.groupId, nickname || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/known-groups/:groupId', (req, res) => {
  try {
    req.userDb.deleteKnownGroup(req.params.groupId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTO-ESCALA DE GRUPOS (SÉRIE) =====

app.get('/api/group-series', (req, res) => {
  res.json(req.userDb.getAllGroupSeries());
});

app.get('/api/group-series/:id', async (req, res) => {
  try {
    const detail = await bot.getGroupSeriesDetail(req.userId, req.params.id);
    res.json(detail);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/group-series', async (req, res) => {
  try {
    const { name, member_threshold, groupId } = req.body;
    const result = await bot.createGroupSeries(req.userId, { name, member_threshold: parseInt(member_threshold) || 1000, groupId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/group-series/:id', (req, res) => {
  try {
    req.userDb.deleteGroupSeries(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/group-series/:id', (req, res) => {
  try {
    const existing = req.userDb.getGroupSeriesById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Série não encontrada' });
    const { name, member_threshold, active } = req.body;
    req.userDb.updateGroupSeries(req.params.id, {
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
// OBS: ainda compartilhado globalmente (não isolado por usuário) — ver observação
// no webhook do Instagram acima. As regras sempre ficam no banco do usuário
// admin, pra bater com o que o webhook (que não tem sessão de usuário) lê.
app.use('/api/instagram-comment-rules', (req, res, next) => {
  const admin = getAdminUser();
  if (!admin) return res.status(400).json({ error: 'PANEL_USER não configurado — Instagram não disponível.' });
  req.userDb = db.getUserDb(admin.id);
  next();
});

app.get('/api/instagram/status', (req, res) => {
  res.json({ configured: instagram.isConfigured(), env: instagram.getConfigStatus() });
});

app.get('/api/instagram-comment-rules', (req, res) => {
  res.json(req.userDb.getAllInstagramCommentRules());
});

app.get('/api/instagram-comment-rules/:id', (req, res) => {
  const rule = req.userDb.getInstagramCommentRuleById(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
  res.json(rule);
});

app.post('/api/instagram-comment-rules', (req, res) => {
  try {
    const rule = req.body;
    if (!rule.name || !rule.keywords) return res.status(400).json({ error: 'Nome e palavras-chave são obrigatórios' });
    if (!rule.reply_text) return res.status(400).json({ error: 'Texto da resposta é obrigatório' });
    const result = req.userDb.addInstagramCommentRule(rule);
    res.json({ id: result.lastInsertRowid, ...rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/instagram-comment-rules/:id', (req, res) => {
  try {
    req.userDb.updateInstagramCommentRule(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/instagram-comment-rules/:id', (req, res) => {
  try {
    req.userDb.deleteInstagramCommentRule(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/instagram-comment-rules/:id/toggle', (req, res) => {
  const { active } = req.body;
  req.userDb.toggleInstagramCommentRule(req.params.id, active ? 1 : 0);
  res.json({ ok: true });
});

// ===== INICIALIZACAO =====

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n  ML WhatsApp Bot rodando em http://localhost:' + PORT + '\n');
  // Migra a sessão WhatsApp de antes do multiusuário (se existir) pro usuário
  // criado a partir de PANEL_USER, e retoma automaticamente todo usuário que
  // já tinha uma sessão WhatsApp autenticada (sobrevive a redeploy/restart).
  const admin = getAdminUser();
  if (admin) {
    bot.migrateLegacyAuthDir(admin.id);
    migrateLegacyMlSession(admin.id);
  }
  bot.resumeAllExistingSessions(io).catch(err => console.error('[Bot] Falha ao retomar sessões existentes:', err.message));
});
