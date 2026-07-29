const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidDecode } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const cron = require('node-cron');
const { generatePostText, generateCustomMessage } = require('./claude');
const { fetchPromoProducts, generateAffiliateLink } = require('./mercadolivre');
const db = require('./database');
const webhooks = require('./webhooks');

let client = null;
let qrCodeData = null;
let botStatus = 'disconnected'; // disconnected | qr_pending | connected
let cronJob = null;
let manualDisconnect = false; // true quando o usuário pede desconexão pelo painel (não deve auto-reconectar)

function getStatus() {
  return { status: botStatus, qr: qrCodeData };
}

/**
 * Resolve a lista de grupos que devem receber os posts de oferta: une os grupos
 * configurados manualmente (whatsapp_group_ids) com todos os grupos de qualquer
 * série de auto-escala (group_series_groups) — inclusive os já marcados "full",
 * já que grupos cheios continuam recebendo ofertas, só param de receber leads novos.
 * Sem cap de 5: esse limite existia antes da auto-escala e passaria a quebrar o
 * fluxo assim que uma série ultrapassasse 5 grupos.
 */
function resolveOfferGroupIds() {
  const manualSetting = db.getSetting('whatsapp_group_ids') || db.getSetting('whatsapp_group_id') || '';
  const manualIds = manualSetting.split(',').map(g => g.trim()).filter(Boolean);
  const seriesIds = db.getAllGroupSeriesGroupIds();
  return [...new Set([...manualIds, ...seriesIds])];
}

const AUTH_DIR = './data/baileys-auth';

async function initWhatsApp(io) {
  manualDisconnect = false;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  client = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('ML Bot'),
  });

  client.ev.on('creds.update', saveCreds);

  client.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      botStatus = 'qr_pending';
      qrCodeData = await qrcode.toDataURL(qr);
      console.log('[Bot] QR Code gerado — escaneie pelo WhatsApp');
      if (io) io.emit('status', getStatus());
    }

    if (connection === 'open') {
      botStatus = 'connected';
      qrCodeData = null;
      console.log('[Bot] WhatsApp conectado!');
      if (io) io.emit('status', getStatus());
      startCron(io);
    }

    if (connection === 'close') {
      botStatus = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('[Bot] Desconectado. Código:', statusCode, lastDisconnect?.error?.message || '');
      if (io) io.emit('status', getStatus());
      if (cronJob) { cronJob.stop(); cronJob = null; }

      if (statusCode === DisconnectReason.loggedOut) {
        // Sessão invalidada pelo próprio WhatsApp (ex: removido dos aparelhos conectados) —
        // limpa credenciais salvas, só reconecta com um novo QR Code.
        const fs = require('fs');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
      } else if (!manualDisconnect) {
        console.log('[Bot] Tentando reconectar automaticamente...');
        initWhatsApp(io).catch(err => console.error('[Bot] Falha ao reconectar:', err.message));
      }
    }
  });

  client.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      handleIncomingMessage(msg, io).catch(err => console.error('[AutoReply] Erro no handler:', err.message));
    }
  });

  client.ev.on('group-participants.update', (update) => {
    db.touchKnownGroup(update.id, update.action === 'remove' ? 'group_leave' : 'group_join');
    if (update.action === 'add') {
      handleGroupJoin(update, io).catch(err => console.error('[GroupJoin] Erro no handler:', err.message));
      checkGroupSeriesGrowth(update, io).catch(err => console.error('[GroupSeries] Erro no handler:', err.message));
    } else if (update.action === 'remove') {
      handleGroupLeave(update, io).catch(err => console.error('[GroupLeave] Erro no handler:', err.message));
    }
  });
}

function startCron(io) {
  if (cronJob) cronJob.stop();

  const maxPerDay = parseInt(db.getSetting('max_posts_per_day') || '6');
  const botActive = db.getSetting('bot_active') === '1';

  if (!botActive) {
    console.log('[Cron] Bot desativado nas configurações.');
    return;
  }

  // Roda a cada minuto e checa se o horário atual está na lista configurada
  cronJob = cron.schedule('* * * * *', async () => {
    const timesRaw = db.getSetting('post_times') || '09:00,12:00,18:00';
    const daysRaw  = db.getSetting('post_days')  || '*';

    const now = new Date();
    const hh  = String(now.getHours()).padStart(2, '0');
    const mm  = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hh}:${mm}`;
    const currentDay  = String(now.getDay()); // 0=Dom ... 6=Sáb

    const times = timesRaw.split(',').map(t => t.trim()).filter(Boolean);
    const days  = daysRaw === '*' ? null : daysRaw.split(',').map(d => d.trim());

    // Mensagens agendadas verificadas a cada minuto (independente dos horários de produto)
    await checkScheduledMessages(io);

    if (!times.includes(currentTime)) return;
    if (days && !days.includes(currentDay)) return;

    console.log(`[Cron] ⏰ Horário ${currentTime} — executando post...`);
    await runPost(maxPerDay, io);
  });

  const timesDisplay = db.getSetting('post_times') || '09:00,12:00,18:00';
  console.log(`[Cron] Agendamento ativo: ${timesDisplay}`);
}

/**
 * Busca um produto pra postar: tenta o Mercado Livre primeiro. Se o ML bloquear/falhar
 * (fetchPromoProducts lança erro — bloqueio antibot, rede, etc.), cai automaticamente pra
 * um produto aleatório já cadastrado no sistema, evitando repetir um postado recentemente.
 * Retorna { product: null, fallback: false } se realmente não achou nada em nenhuma fonte
 * (sem lançar erro) — só lança se o ML falhou E não há nenhum produto cadastrado disponível.
 */
async function resolveProductToPost({ minDiscount, keywords, priceMin, priceMax, excludeIds }) {
  try {
    const promos = await fetchPromoProducts({ minDiscount, keywords, priceMin, priceMax, limit: 1, excludeIds });
    return { product: promos[0] || null, fallback: false };
  } catch (err) {
    console.error('[Post] Falha ao buscar no ML, tentando produto de fallback já cadastrado:', err.message);
    const eligible = db.getActiveProducts().filter(p => {
      if (p.ml_id && excludeIds.has(p.ml_id)) return false;
      if (p.ml_id && db.wasPostedRecentlyByMlId(p.ml_id, 24)) return false;
      return true;
    });
    if (!eligible.length) {
      throw new Error(`${err.message} Além disso, não há produtos cadastrados disponíveis pra usar como alternativa.`);
    }
    const chosen = eligible[Math.floor(Math.random() * eligible.length)];
    console.log(`[Post] 🔁 Usando produto de fallback: ${chosen.title}`);
    return { product: chosen, fallback: true };
  }
}

async function runPost(maxPerDay, io) {
  try {
    const todayCount = db.getPostsToday().count;
    if (todayCount >= maxPerDay) {
      console.log(`[Post] Limite diário atingido (${todayCount}/${maxPerDay})`);
      return;
    }

    const groupIds = resolveOfferGroupIds();
    if (!groupIds.length) {
      console.log('[Post] Nenhum grupo do WhatsApp configurado.');
      return;
    }

    const minDiscount = parseInt(db.getSetting('min_discount') || '20');
    const keywords = db.getSetting('search_keywords') || '';
    const _pMin = db.getSetting('price_min'); const priceMin = _pMin && parseFloat(_pMin) > 0 ? _pMin : null;
    const _pMax = db.getSetting('price_max'); const priceMax = _pMax && parseFloat(_pMax) > 0 ? _pMax : null;

    // 1. Tenta buscar o primeiro produto válido no ML (já exclui os postados recentemente);
    // se o ML bloquear/falhar, resolveProductToPost já cai pra um produto cadastrado aleatório.
    const recentIds = new Set(
      db.getPostHistory(200).map(h => h.ml_id).filter(Boolean)
    );
    // Monta set de exclusão: postados nas últimas 24h + bloqueados
    const excludeIds = new Set([...recentIds].filter(id => db.wasPostedRecentlyByMlId(id, 24) || db.isBlocked(id)));

    console.log(`[Post] Buscando promoção no ML... desconto>=${minDiscount}% | excluindo ${excludeIds.size} IDs recentes`);
    let product, fallback;
    try {
      ({ product, fallback } = await resolveProductToPost({ minDiscount, keywords, priceMin, priceMax, excludeIds }));
    } catch (err) {
      console.error('[Post] ML e fallback falharam:', err.message);
      return;
    }

    if (!product) {
      console.log('[Post] Nenhum produto encontrado no ML agora. Tentará novamente no próximo horário.');
      return;
    }

    if (!fallback) {
      const existing = db.getProductByMlId(product.ml_id);
      if (existing) {
        product.id = existing.id;
      } else {
        const { catalog_id, ...productToSave } = product;
        const result = db.addProduct(productToSave);
        product.id = result.lastInsertRowid;
      }
    }

    console.log(`[Post] Gerando texto para: ${product.title} (${product.discount_percent}% off)${fallback ? ' [fallback]' : ''}`);
    const text = await generatePostText(product);
    const link = product.affiliate_url || product.url;
    const finalText = `${link}\n\n${text}`;

    const { sent, failed } = await sendToGroups(groupIds, finalText, product.image_url);
    if (failed.length) console.error(`[Post] ⚠️ Falhou em ${failed.length}/${groupIds.length} grupo(s):`, failed.map(f => f.gid).join(', '));
    db.addPostHistory(product.id, finalText, 'sent', product.ml_id || null);
    if (io) io.emit('post_sent', { product: product.title, text: finalText, groups: sent.length, failed: failed.length, fallback });
  } catch (err) {
    console.error('[Post] Erro ao enviar:', err.message);
  }
}

async function sendManualPost(productId, io) {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');

  const product = db.getProductById(productId);
  if (!product) throw new Error('Produto não encontrado.');

  const groupIds = resolveOfferGroupIds();
  if (!groupIds.length) throw new Error('Nenhum grupo do WhatsApp configurado.');

  const text = await generatePostText(product);
  const link = product.affiliate_url || product.url;
  const finalText = `${link}\n\n${text}`;

  const { sent, failed } = await sendToGroups(groupIds, finalText, product.image_url);
  db.addPostHistory(product.id, finalText, 'manual', product.ml_id || null);
  if (!sent.length) throw new Error(`Falha ao enviar para todos os ${failed.length} grupo(s): ${failed[0]?.error}`);
  if (failed.length) console.error(`[ManualPost] ⚠️ Falhou em ${failed.length}/${groupIds.length} grupo(s):`, failed.map(f => f.gid).join(', '));

  return finalText;
}

/**
 * Lista os grupos que o bot participa, com nome, contagem de participantes,
 * se o bot é admin e se foi o bot quem criou o grupo — tudo via groupFetchAllParticipating,
 * uma chamada local só, sem depender de nada que o whatsapp-web.js quebrava.
 */
// Extrai só a parte "número/usuário" de um JID, ignorando sufixo de dispositivo (:5) e domínio
// (@s.whatsapp.net, @lid, @g.us) — necessário porque a Baileys pode representar o mesmo usuário
// ora como LID (@lid) ora como número de telefone (@s.whatsapp.net) dependendo do contexto,
// e comparar os JIDs completos direto falha nesses casos.
function jidUserPart(jid) {
  if (!jid) return null;
  return jidDecode(jid)?.user || jid.split('@')[0].split(':')[0];
}

async function getGroups() {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');
  const groups = await client.groupFetchAllParticipating();
  const myIds = new Set([client.user?.id, client.user?.lid, client.user?.phoneNumber].filter(Boolean).map(jidUserPart));

  return Object.values(groups)
    .map(g => {
      const meParticipant = g.participants?.find(p => {
        const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(jidUserPart);
        return ids.some(id => myIds.has(id));
      });
      const isAdmin = meParticipant?.admin === 'admin' || meParticipant?.admin === 'superadmin';
      const ownerIds = [g.owner, g.ownerPn].filter(Boolean).map(jidUserPart);
      const isOwner = ownerIds.some(id => myIds.has(id));
      return { id: g.id, name: g.subject, participants: g.participants?.length || 0, isAdmin, isOwner, isOpen: !g.announce };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function leaveGroup(groupId) {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');
  await client.groupLeave(groupId);
  return { ok: true };
}

/**
 * Envia uma mensagem para um grupo/contato.
 * Se tiver image_url, envia a foto com o texto como legenda (imagem garantida).
 * Caso contrário, envia texto puro.
 */
async function sendPost(jid, text, imageUrl) {
  if (imageUrl) {
    try {
      let imageContent;
      if (imageUrl.startsWith('data:')) {
        const [, b64] = imageUrl.split(',');
        imageContent = Buffer.from(b64, 'base64');
      } else {
        imageContent = { url: imageUrl };
      }
      return await client.sendMessage(jid, { image: imageContent, caption: text });
    } catch (e) {
      console.log(`[Bot] Falha ao enviar imagem (${e.message}), enviando texto puro.`);
    }
  }
  return client.sendMessage(jid, { text });
}

/**
 * Envia a um grupo, isolando falhas de cada destinatário (uma falha não derruba os demais).
 * Loga sucesso/erro por grupo — inclusive o ID da mensagem retornado, pra diagnosticar
 * casos em que o envio "resolve com sucesso" mas a mensagem não chega de fato.
 */
async function sendToGroups(groupIds, text, imageUrl) {
  const sent = [];
  const failed = [];
  for (const gid of groupIds) {
    try {
      const result = await sendPost(gid, text, imageUrl);
      const msgId = result?.key?.id || null;
      console.log(`[Bot] ✅ Enviado para ${gid}${msgId ? ` (msg id: ${msgId})` : ' — ⚠️ sem ID de mensagem retornado, confirme se chegou de verdade no grupo'}`);
      sent.push(gid);
    } catch (err) {
      console.error(`[Bot] ❌ Falha ao enviar para ${gid}: ${err.message}`);
      failed.push({ gid, error: err.message });
    }
  }
  return { sent, failed };
}

function reloadCron(io) {
  if (botStatus === 'connected') startCron(io);
}

// ===== RESPOSTAS AUTOMÁTICAS / MODERAÇÃO =====

function matchesAutoReplyRule(rule, text) {
  const raw = text || '';
  if (rule.trigger_type === 'regex') {
    try {
      const re = new RegExp(rule.keywords, rule.case_sensitive ? '' : 'i');
      return re.test(raw);
    } catch (_) { return false; }
  }
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

function extractMessageText(msg) {
  const m = msg.message;
  if (!m) return '';
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || '';
}

async function handleIncomingMessage(msg, io) {
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid === 'status@broadcast') return;
  if (!msg.message) return; // eventos sem conteúdo (ex: mensagem apagada, recibo)

  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  const senderId = msg.key.participant || chatId; // em grupo, quem mandou; em DM, o próprio chat
  const body = extractMessageText(msg);

  if (msg.pushName) {
    if (isGroup) db.touchKnownContact(senderId, msg.pushName);
    else db.touchKnownContact(chatId, msg.pushName);
  }

  if (isGroup) {
    db.touchKnownGroup(chatId, 'message');
    const known = db.getKnownGroupById(chatId);
    if (!known?.nickname) {
      try {
        const meta = await client.groupMetadata(chatId);
        if (meta?.subject) db.setKnownGroupNicknameIfEmpty(chatId, meta.subject);
      } catch (err) {
        console.log(`[Message] Falha ao buscar nome do grupo ${chatId}: ${err.message}`);
      }
    }
  } else {
    db.touchKnownContact(chatId, msg.pushName);
  }

  // Webhook de saída — não bloqueia o resto do fluxo
  webhooks.dispatchEvent('message_received', {
    from: chatId,
    isGroup,
    body,
    author: msg.key.participant || null,
    timestamp: msg.messageTimestamp,
  }).catch(() => {});

  // Moderação (só faz sentido em grupo)
  const LINK_REGEX = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i;
  if (isGroup) {
    try {
      const gs = db.getGroupSettings(chatId);
      if (gs.moderation_enabled) {
        const words = (gs.blocked_words || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
        const bodyLower = body.toLowerCase();
        const hitWord = words.find(w => w && bodyLower.includes(w));
        const hitLink = gs.moderation_block_links && LINK_REGEX.test(body);

        if (hitWord || hitLink) {
          const reason = hitLink && !hitWord ? 'link não permitido' : `termo não permitido ("${hitWord}")`;

          if (gs.moderation_action === 'delete' || gs.moderation_action === 'delete_warn') {
            try { await client.sendMessage(chatId, { delete: msg.key }); } catch (e) { console.log('[Moderation] Falha ao apagar (o bot precisa ser admin do grupo):', e.message); }
          }
          if (gs.moderation_action === 'warn' || gs.moderation_action === 'delete_warn') {
            const warnText = `⚠️ Mensagem removida/flagrada por conter ${reason}.`;
            if (gs.moderation_send_group) {
              try { await client.sendMessage(chatId, { text: warnText }); } catch (_) {}
            }
            if (gs.moderation_send_dm && senderId !== chatId) {
              try { await client.sendMessage(senderId, { text: warnText }); } catch (_) {}
            }
          }

          if (gs.moderation_kick_enabled && senderId !== chatId) {
            const strikes = db.addModerationStrike(chatId, senderId);
            console.log(`[Moderation] ${senderId} em ${chatId}: ${strikes}/3 violações`);
            if (strikes >= 3) {
              try {
                await client.groupParticipantsUpdate(chatId, [senderId], 'remove');
                db.resetModerationStrikes(chatId, senderId);
                console.log(`[Moderation] 🚫 ${senderId} removido de ${chatId} após 3 violações.`);
                if (gs.moderation_send_group) {
                  try { await client.sendMessage(chatId, { text: '🚫 Um participante foi removido automaticamente por reincidir em violações das regras do grupo.' }); } catch (_) {}
                }
              } catch (err) {
                console.log('[Moderation] Falha ao remover participante (o bot precisa ser admin do grupo):', err.message);
              }
            }
          }

          return; // mensagem moderada não passa pelas respostas automáticas
        }
      }
    } catch (err) {
      console.error('[Moderation] Erro:', err.message);
    }
  }

  // Respostas automáticas
  try {
    const rules = db.getActiveAutoReplyRules();
    for (const rule of rules) {
      if (rule.scope === 'groups' && !isGroup) continue;
      if (rule.scope === 'dms' && isGroup) continue;
      if (isGroup && rule.group_ids) {
        const allowedIds = rule.group_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (allowedIds.length && !allowedIds.includes(chatId)) continue;
      }
      if (!matchesAutoReplyRule(rule, body)) continue;
      if (db.wasAutoReplyFiredRecently(rule.id, chatId, rule.cooldown_minutes)) continue;

      let replyText = rule.reply_text || '';
      if (rule.reply_type === 'ai' && rule.ai_prompt) {
        try {
          replyText = await generateCustomMessage(rule.ai_prompt, { extra: body });
        } catch (err) {
          console.error('[AutoReply] Erro ao gerar resposta com IA:', err.message);
        }
      }

      if (replyText && replyText.trim()) {
        await client.sendMessage(chatId, { text: replyText.trim() });
        db.logAutoReplyFired(rule.id, chatId);
        console.log(`[AutoReply] ✅ Regra "${rule.name}" respondeu em ${chatId}`);
        if (io) io.emit('auto_reply_sent', { rule: rule.name, chat: chatId });
      }

      if (rule.stop_on_match) break;
    }
  } catch (err) {
    console.error('[AutoReply] Erro:', err.message);
  }
}

// ===== GESTÃO DE GRUPOS (boas-vindas / despedida) =====

function resolveParticipantNames(participants) {
  if (!participants?.length) return '';
  const names = participants
    .map(p => db.getKnownContactPushName(p.id) || p.notify || p.name || (p.id || '').split('@')[0])
    .filter(Boolean);
  return names.join(', ');
}

async function getGroupName(groupId) {
  try {
    const meta = await client.groupMetadata(groupId);
    return meta?.subject || groupId;
  } catch (_) {
    return groupId;
  }
}

function resolveSingleParticipantName(p) {
  return db.getKnownContactPushName(p.id) || p.notify || p.name || (p.id || '').split('@')[0] || 'novo(a) integrante';
}

async function handleGroupJoin(update, io) {
  const groupId = update.id;
  const gs = db.getGroupSettings(groupId);
  if (!gs.welcome_enabled) return;

  const groupName = await getGroupName(groupId);

  if (gs.welcome_send_group) {
    const combinedName = resolveParticipantNames(update.participants);
    const text = (gs.welcome_message || '').replace(/\{name\}/g, combinedName || 'novo(a) integrante').replace(/\{group\}/g, groupName);
    if (text.trim()) {
      try {
        await client.sendMessage(groupId, { text });
        if (io) io.emit('group_welcome_sent', { group: groupName });
      } catch (err) {
        console.error('[GroupJoin] Erro ao enviar boas-vindas no grupo:', err.message);
      }
    }
  }

  if (gs.welcome_send_dm) {
    for (const p of update.participants || []) {
      const text = (gs.welcome_message || '').replace(/\{name\}/g, resolveSingleParticipantName(p)).replace(/\{group\}/g, groupName);
      if (!text.trim()) continue;
      try { await client.sendMessage(p.id, { text }); } catch (err) { console.error(`[GroupJoin] Erro ao enviar boas-vindas por DM pra ${p.id}:`, err.message); }
    }
  }
}

async function handleGroupLeave(update, io) {
  const groupId = update.id;
  const gs = db.getGroupSettings(groupId);
  if (!gs.farewell_enabled) return;

  const groupName = await getGroupName(groupId);

  if (gs.farewell_send_group) {
    const combinedName = resolveParticipantNames(update.participants);
    const text = (gs.farewell_message || '').replace(/\{name\}/g, combinedName || 'um integrante').replace(/\{group\}/g, groupName);
    if (text.trim()) {
      try {
        await client.sendMessage(groupId, { text });
        if (io) io.emit('group_farewell_sent', { group: groupName });
      } catch (err) {
        console.error('[GroupLeave] Erro ao enviar despedida no grupo:', err.message);
      }
    }
  }

  if (gs.farewell_send_dm) {
    for (const p of update.participants || []) {
      const text = (gs.farewell_message || '').replace(/\{name\}/g, resolveSingleParticipantName(p)).replace(/\{group\}/g, groupName);
      if (!text.trim()) continue;
      try { await client.sendMessage(p.id, { text }); } catch (err) { console.error(`[GroupLeave] Erro ao enviar despedida por DM pra ${p.id}:`, err.message); }
    }
  }
}

// ===== AUTO-ESCALA DE GRUPOS (SÉRIE) =====

async function checkGroupSeriesGrowth(update, io) {
  const groupId = update.id;
  const seriesGroup = db.getGroupSeriesGroupByGroupId(groupId);
  if (!seriesGroup) return; // esse grupo não faz parte de nenhuma série de auto-escala

  const series = db.getGroupSeriesById(seriesGroup.series_id);
  if (!series || !series.active) return;

  let participantCount = 0;
  try {
    const meta = await client.groupMetadata(groupId);
    participantCount = meta?.participants?.length || 0;
  } catch (_) {}
  if (participantCount < series.member_threshold) return;

  await growGroupSeries(series, seriesGroup, io);
}

async function growGroupSeries(series, fullSeriesGroup, io) {
  if (botStatus !== 'connected') return;
  const nextSeq = fullSeriesGroup.sequence_number + 1;
  const nextName = `${series.name} #${nextSeq}`;

  console.log(`[GroupSeries] "${series.name}" atingiu o limite de ${series.member_threshold} membros — criando "${nextName}"...`);

  let newGroup;
  try {
    newGroup = await client.groupCreate(nextName, []);
  } catch (err) {
    console.error(`[GroupSeries] Falha ao criar "${nextName}": ${err.message}`);
    return; // não marca o grupo antigo como cheio — tenta de novo no próximo membro que entrar
  }

  let inviteCode = null;
  try {
    inviteCode = await client.groupInviteCode(newGroup.id);
  } catch (err) {
    console.error('[GroupSeries] Grupo criado, mas falhou ao buscar link de convite:', err.message);
  }

  db.addGroupSeriesGroup({
    series_id: series.id,
    sequence_number: nextSeq,
    group_id: newGroup.id,
    group_name: nextName,
    invite_code: inviteCode,
    status: 'active',
  });
  db.markGroupSeriesGroupFull(fullSeriesGroup.id);

  console.log(`[GroupSeries] ✅ "${nextName}" criado e virou o grupo ativo da série "${series.name}".`);
  if (io) io.emit('group_series_grew', { series: series.name, newGroup: nextName });
}

async function getActiveSeriesGroupLink(seriesId) {
  const active = db.getActiveGroupInSeries(seriesId);
  if (!active || !active.invite_code) return null;
  return `https://chat.whatsapp.com/${active.invite_code}`;
}

async function createGroupSeries({ name, member_threshold, groupId }) {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');
  if (!name?.trim()) throw new Error('Nome da série é obrigatório.');
  if (!groupId) throw new Error('Selecione o grupo #1 já existente.');

  const meta = await client.groupMetadata(groupId);
  if (!meta) throw new Error('Grupo inválido.');

  let inviteCode = null;
  try { inviteCode = await client.groupInviteCode(groupId); } catch (err) {
    console.error('[GroupSeries] Falha ao buscar link de convite do grupo #1:', err.message);
  }

  const result = db.addGroupSeries({ name: name.trim(), member_threshold: member_threshold || 1000, active: 1 });
  const seriesId = result.lastInsertRowid;
  db.addGroupSeriesGroup({
    series_id: seriesId,
    sequence_number: 1,
    group_id: groupId,
    group_name: meta.subject || groupId,
    invite_code: inviteCode,
    status: 'active',
  });

  return { id: seriesId, name: name.trim(), member_threshold: member_threshold || 1000 };
}

async function getGroupSeriesDetail(seriesId) {
  const series = db.getGroupSeriesById(seriesId);
  if (!series) throw new Error('Série não encontrada.');
  const groups = db.getGroupSeriesGroups(seriesId);

  const groupsWithCounts = await Promise.all(groups.map(async (g) => {
    let participantCount = null;
    if (botStatus === 'connected') {
      try {
        const meta = await client.groupMetadata(g.group_id);
        participantCount = meta?.participants?.length ?? null;
      } catch (_) { /* grupo pode ter sido removido/saído */ }
    }
    return { ...g, participant_count: participantCount };
  }));

  return { ...series, groups: groupsWithCounts };
}

// ===== INTEGRAÇÕES / CAMPANHAS — utilitários compartilhados =====

function normalizeWhatsAppId(to) {
  if (!to) throw new Error('Destino não informado.');
  const trimmed = String(to).trim();
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) throw new Error(`Destino inválido: ${to}`);
  return `${digits}@s.whatsapp.net`;
}

async function sendInboundMessage({ to, text, imageUrl }) {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');
  if (!text?.trim() && !imageUrl) throw new Error('Mensagem vazia.');
  const target = normalizeWhatsAppId(to);
  await sendPost(target, text || '', imageUrl);
  return { ok: true, to: target };
}

async function getKnownContactIds() {
  return new Set(db.getAllKnownContactIds());
}

// ===== CAMPANHAS — driver =====

async function tickCampaigns() {
  if (botStatus !== 'connected') return;
  let running;
  try { running = db.getRunningCampaigns(); } catch (_) { return; }

  for (const campaign of running) {
    if (campaign.next_send_at && new Date(campaign.next_send_at) > new Date()) continue;

    const recipient = db.getNextPendingRecipient(campaign.id);
    if (!recipient) {
      db.updateCampaignStatus(campaign.id, 'completed', { finished_at: new Date().toISOString() });
      continue;
    }

    try {
      const result = await sendPost(recipient.target_id, campaign.message_text || '', campaign.image_url);
      const msgId = result?.key?.id || null;
      console.log(`[Campaign] ✅ ${recipient.target_id}${msgId ? ` (msg id: ${msgId})` : ' — ⚠️ sem ID de mensagem retornado'}`);
      db.markRecipientSent(recipient.id);
    } catch (err) {
      db.markRecipientFailed(recipient.id, err.message);
    }

    const min = campaign.delay_min_seconds ?? 8;
    const max = Math.max(min, campaign.delay_max_seconds ?? 20);
    const delayMs = 1000 * (min + Math.random() * (max - min));
    db.setCampaignNextSendAt(campaign.id, new Date(Date.now() + delayMs).toISOString());
  }
}

setInterval(() => { tickCampaigns().catch(err => console.error('[Campaigns] Erro no tick:', err.message)); }, 3000);

function startCampaign(id) {
  const campaign = db.getCampaignById(id);
  if (!campaign) throw new Error('Campanha não encontrada.');
  const extra = campaign.status === 'draft' ? { started_at: new Date().toISOString() } : {};
  db.updateCampaignStatus(id, 'running', extra);
  db.setCampaignNextSendAt(id, new Date().toISOString());
  return { ok: true };
}

function pauseCampaign(id) {
  const campaign = db.getCampaignById(id);
  if (!campaign) throw new Error('Campanha não encontrada.');
  db.updateCampaignStatus(id, 'paused');
  return { ok: true };
}

function cancelCampaign(id) {
  const campaign = db.getCampaignById(id);
  if (!campaign) throw new Error('Campanha não encontrada.');
  db.updateCampaignStatus(id, 'cancelled', { finished_at: new Date().toISOString() });
  return { ok: true };
}

// Versão pública do runPost para chamada manual via API (ignora limite diário)
async function runAutoPost(io) {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');

  const groupIds = resolveOfferGroupIds();
  if (!groupIds.length) throw new Error('Nenhum grupo do WhatsApp configurado.');

  const minDiscount = parseInt(db.getSetting('min_discount') || '20');
  const keywords = db.getSetting('search_keywords') || '';
  const priceMin = db.getSetting('price_min') || null;
  const priceMax = db.getSetting('price_max') || null;

  const recentIds = new Set(db.getPostHistory(200).map(h => h.ml_id).filter(Boolean));
  const excludeIds = new Set([...recentIds].filter(id => db.wasPostedRecentlyByMlId(id, 24) || db.isBlocked(id)));

  const { product, fallback } = await resolveProductToPost({ minDiscount, keywords, priceMin, priceMax, excludeIds });
  if (!product) throw new Error('Nenhum produto em promoção encontrado no momento. Tente novamente em instantes ou cadastre produtos manualmente.');

  if (!fallback) {
    // affiliate_url já vem com meli.la do fetchPromoProducts — não sobrescrever
    const existing = db.getProductByMlId(product.ml_id);
    if (existing) {
      product.id = existing.id;
      product.affiliate_url = existing.affiliate_url || product.affiliate_url;
    } else {
      const { catalog_id, ...productToSave } = product;
      const result = db.addProduct(productToSave);
      product.id = result.lastInsertRowid;
    }
  }

  const text = await generatePostText(product);
  const link = product.affiliate_url || product.url;
  const finalText = `${link}\n\n${text}`;

  const { sent, failed } = await sendToGroups(groupIds, finalText, product.image_url);
  db.addPostHistory(product.id, finalText, 'sent', product.ml_id || null);
  if (io) io.emit('post_sent', { product: product.title, text: finalText, groups: sent.length, failed: failed.length, fallback });

  if (!sent.length) {
    throw new Error(`O produto foi encontrado, mas o envio falhou para todos os ${failed.length} grupo(s). Erro: ${failed[0]?.error}`);
  }

  return {
    ok: true, product: product.title, discount: product.discount_percent, text: finalText,
    groupsSent: sent.length, groupsFailed: failed.length, usedFallback: fallback,
    warning: failed.length ? `Falhou em ${failed.length} de ${groupIds.length} grupo(s) — veja o log do servidor.` : null,
  };
}

async function reconnectWhatsApp(io) {
  if (botStatus === 'connected' || botStatus === 'qr_pending') return;
  console.log('[Bot] Reconectando WhatsApp...');
  try {
    if (client) { try { client.end(undefined); } catch (_) {} }
  } catch (_) {}
  client = null;
  await initWhatsApp(io);
}

async function disconnectWhatsApp(io) {
  console.log('[Bot] Desconectando WhatsApp...');
  manualDisconnect = true;
  if (cronJob) { cronJob.stop(); cronJob = null; }
  try {
    if (client) {
      try { await client.logout(); } catch (_) {}
      try { client.end(undefined); } catch (_) {}
    }
  } catch (_) {}
  client = null;
  botStatus = 'disconnected';
  qrCodeData = null;
  // Remove sessão salva para forçar novo QR na próxima conexão
  const fs = require('fs');
  const path = require('path');
  const authPath = path.join(__dirname, '..', AUTH_DIR);
  try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (_) {}
  if (io) io.emit('status', getStatus());
  console.log('[Bot] WhatsApp desconectado e sessão removida.');
}

const DAY_NAMES = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];

async function checkScheduledMessages(io) {
  if (botStatus !== 'connected') return;
  const messages = db.getAllScheduledMessages().filter(m => m.active);
  if (!messages.length) return;

  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const currentDay = String(now.getDay());
  const monthDay = `${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`;

  for (const msg of messages) {
    try {
      // Check day filter
      if (msg.days && msg.days !== '*') {
        const days = msg.days.split(',').map(d => d.trim());
        if (!days.includes(currentDay)) continue;
      }

      // Already fired today?
      if (db.wasScheduledMessageFiredToday(msg.id, today)) continue;

      // Get or generate target time for today
      let targetTime = db.getTargetTime(msg.id, today);
      if (!targetTime) {
        const [sh, sm] = (msg.time_start || '08:00').split(':').map(Number);
        const endStr = msg.time_end || msg.time_start || '08:00';
        const [eh, em] = endStr.split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;
        const rand = startMin + Math.floor(Math.random() * Math.max(1, endMin - startMin + 1));
        targetTime = `${String(Math.floor(rand/60)).padStart(2,'0')}:${String(rand%60).padStart(2,'0')}`;
        db.setTargetTime(msg.id, today, targetTime);
        console.log(`[ScheduledMsg] "${msg.name}" — horário de hoje: ${targetTime}`);
      }

      if (currentTime !== targetTime) continue;

      // Determine groups
      const groupIds = (msg.group_ids || '').split(',').map(g => g.trim()).filter(Boolean);
      if (!groupIds.length) {
        console.log(`[ScheduledMsg] "${msg.name}" — nenhum grupo configurado.`);
        db.logScheduledMessageFired(msg.id, today);
        continue;
      }

      // Determine message text
      let text = '';
      try {
        const specialDates = JSON.parse(msg.special_dates || '[]');
        const found = specialDates.find(s => s.date === monthDay);
        if (found) { text = found.message; }
      } catch (_) {}

      if (!text) {
        if (msg.type === 'ai') {
          text = await generateCustomMessage(msg.ai_prompt || '', {
            date: now.toLocaleDateString('pt-BR'),
            dayName: DAY_NAMES[now.getDay()],
          });
        } else {
          text = msg.message_text || '';
        }
      }

      if (!text.trim()) {
        db.logScheduledMessageFired(msg.id, today);
        continue;
      }

      const { failed } = await sendToGroups(groupIds, text.trim(), null);
      if (failed.length) console.error(`[ScheduledMsg] ⚠️ "${msg.name}" falhou em ${failed.length}/${groupIds.length} grupo(s)`);
      db.logScheduledMessageFired(msg.id, today);
      if (io) io.emit('scheduled_msg_sent', { name: msg.name, text });

    } catch (err) {
      console.error(`[ScheduledMsg] Erro em "${msg.name}":`, err.message);
    }
  }
}

async function broadcastToGroups(text, groupIds) {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');
  if (!text?.trim()) throw new Error('Mensagem não pode estar vazia.');
  if (!groupIds?.length) throw new Error('Nenhum grupo selecionado.');
  const { sent, failed } = await sendToGroups(groupIds, text.trim(), null);
  if (!sent.length) throw new Error(`Falha ao enviar para todos os ${failed.length} grupo(s): ${failed[0]?.error}`);
  return { ok: true, groups: sent.length, failed: failed.length };
}

async function broadcastMessage(text, io) {
  if (botStatus !== 'connected') throw new Error('WhatsApp não está conectado.');
  if (!text?.trim()) throw new Error('Mensagem não pode estar vazia.');
  const groupIds = resolveOfferGroupIds();
  if (!groupIds.length) throw new Error('Nenhum grupo configurado.');
  const { sent, failed } = await sendToGroups(groupIds, text.trim(), null);
  if (!sent.length) throw new Error(`Falha ao enviar para todos os ${failed.length} grupo(s): ${failed[0]?.error}`);
  return { ok: true, groups: sent.length, failed: failed.length };
}

module.exports = {
  initWhatsApp, getStatus, sendManualPost, runAutoPost, reloadCron, getGroups, reconnectWhatsApp, disconnectWhatsApp,
  broadcastMessage, broadcastToGroups,
  sendInboundMessage, getKnownContactIds, normalizeWhatsAppId,
  startCampaign, pauseCampaign, cancelCampaign,
  createGroupSeries, getGroupSeriesDetail, getActiveSeriesGroupLink,
  leaveGroup,
};
