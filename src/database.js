const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'bot.db');
const db = new DatabaseSync(DB_PATH);

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ml_id TEXT UNIQUE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      affiliate_url TEXT,
      price REAL,
      original_price REAL,
      discount_percent INTEGER,
      image_url TEXT,
      category TEXT,
      custom_text TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS post_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      ml_id TEXT,
      message_text TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'sent',
      FOREIGN KEY (product_id) REFERENCES products(id)
    );


    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_products (
      ml_id TEXT PRIMARY KEY,
      blocked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const defaults = [
    ['cron_schedule', '0 9,12,18 * * *'],
    ['bot_timezone', 'America/Sao_Paulo'],
    ['max_posts_per_day', '6'],
    ['whatsapp_group_id', ''],
    ['whatsapp_group_ids', ''],
    ['bot_active', '1'],
    ['post_interval_hours', '3'],
    ['min_discount', '20'],
    ['search_keywords', ''],
    ['price_min', ''],
    ['price_max', ''],
    ['claude_prompt', 'Você é um especialista em marketing de afiliados. Crie uma mensagem de divulgação atraente e persuasiva para o seguinte produto do Mercado Livre. Use emojis, destaque o desconto se houver, e inclua uma chamada para ação. Seja direto e entusiasmado. Máximo 300 caracteres.'],
  ];

  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of defaults) insert.run(key, value);
}

initSchema();

// Migração segura: adiciona ml_id ao histórico se não existir
try {
  db.exec('ALTER TABLE post_history ADD COLUMN ml_id TEXT');
} catch (_) { /* coluna já existe */ }

// ===== PRODUTOS =====
function getAllProducts() {
  return db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
}
function getActiveProducts() {
  return db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC').all();
}
function getProductById(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}
function addProduct(product) {
  return db.prepare(`
    INSERT INTO products (ml_id, title, url, affiliate_url, price, original_price, discount_percent, image_url, category, custom_text)
    VALUES (@ml_id, @title, @url, @affiliate_url, @price, @original_price, @discount_percent, @image_url, @category, @custom_text)
  `).run(product);
}
function updateProduct(id, product) {
  return db.prepare(`
    UPDATE products SET
      title = @title, url = @url, affiliate_url = @affiliate_url,
      price = @price, original_price = @original_price, discount_percent = @discount_percent,
      image_url = @image_url, category = @category, custom_text = @custom_text,
      active = @active, updated_at = datetime('now')
    WHERE id = @id
  `).run({ ...product, id });
}
function deleteProduct(id) {
  try {
    const product = db.prepare('SELECT ml_id FROM products WHERE id = ?').get(id);
    if (product?.ml_id) {
      db.prepare('INSERT OR IGNORE INTO blocked_products (ml_id) VALUES (?)').run(product.ml_id);
    }
  } catch (_) { /* ignora erro no bloqueio */ }
  // Remove referências no histórico antes de deletar o produto
  db.prepare('DELETE FROM post_history WHERE product_id = ?').run(id);
  return db.prepare('DELETE FROM products WHERE id = ?').run(id);
}

function isBlocked(mlId) {
  if (!mlId) return false;
  return !!db.prepare('SELECT 1 FROM blocked_products WHERE ml_id = ?').get(mlId);
}

function unblockProduct(mlId) {
  return db.prepare('DELETE FROM blocked_products WHERE ml_id = ?').run(mlId);
}
function toggleProduct(id, active) {
  return db.prepare("UPDATE products SET active = ?, updated_at = datetime('now') WHERE id = ?").run(active, id);
}

// ===== HISTÓRICO =====
function addPostHistory(productId, messageText, status = 'sent', mlId = null) {
  return db.prepare('INSERT INTO post_history (product_id, ml_id, message_text, status) VALUES (?, ?, ?, ?)').run(productId, mlId, messageText, status);
}
function getPostHistory(limit = 50) {
  return db.prepare(`
    SELECT ph.*, p.title as product_title
    FROM post_history ph
    LEFT JOIN products p ON ph.product_id = p.id
    ORDER BY ph.sent_at DESC LIMIT ?
  `).all(limit);
}
// ===== LOG DE EVENTOS DO ROBÔ (pra aba Histórico Log) =====
function addLog(level, category, message) {
  db.prepare('INSERT INTO event_log (level, category, message) VALUES (?, ?, ?)').run(level, category, message);
  // Mantém só os últimos 500 eventos — é um log operacional, não histórico permanente.
  db.prepare('DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT 500)').run();
}
function getLogs(limit = 200, level = null) {
  if (level) return db.prepare('SELECT * FROM event_log WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, limit);
  return db.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?').all(limit);
}
function clearLogs() {
  return db.prepare('DELETE FROM event_log').run();
}

function getPostsToday() {
  return db.prepare("SELECT COUNT(*) as count FROM post_history WHERE date(sent_at) = date('now')").get();
}
function wasPostedRecently(productId, hours = 24) {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM post_history
    WHERE product_id = ? AND sent_at > datetime('now', '-${hours} hours')
  `).get(productId);
  return result.count > 0;
}
function getProductByMlId(mlId) {
  return db.prepare('SELECT * FROM products WHERE ml_id = ?').get(mlId);
}
function wasPostedRecentlyByMlId(mlId, hours = 24) {
  // Verifica direto na coluna ml_id do histórico (funciona mesmo se o produto foi deletado)
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM post_history
    WHERE ml_id = ? AND sent_at > datetime('now', '-${hours} hours')
  `).get(mlId);
  return result.count > 0;
}

function clearHistory() {
  return db.prepare('DELETE FROM post_history').run();
}

// ===== CONFIGURAÇÕES =====
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  return db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}
function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ===== MENSAGENS AGENDADAS =====
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'fixed',
      message_text TEXT,
      ai_prompt TEXT,
      group_ids TEXT DEFAULT '',
      days TEXT DEFAULT '*',
      time_start TEXT NOT NULL,
      time_end TEXT,
      special_dates TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scheduled_message_targets (
      message_id INTEGER,
      target_date TEXT,
      target_time TEXT,
      PRIMARY KEY (message_id, target_date)
    );
    CREATE TABLE IF NOT EXISTS scheduled_message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER,
      target_date TEXT,
      fired_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch (_) {}

function getAllScheduledMessages() {
  return db.prepare('SELECT * FROM scheduled_messages ORDER BY created_at DESC').all();
}
function getScheduledMessageById(id) {
  return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
}
function addScheduledMessage(msg) {
  return db.prepare(`
    INSERT INTO scheduled_messages (name, type, message_text, ai_prompt, group_ids, days, time_start, time_end, special_dates, active)
    VALUES (@name, @type, @message_text, @ai_prompt, @group_ids, @days, @time_start, @time_end, @special_dates, @active)
  `).run(msg);
}
function updateScheduledMessage(id, msg) {
  return db.prepare(`
    UPDATE scheduled_messages SET
      name=@name, type=@type, message_text=@message_text, ai_prompt=@ai_prompt,
      group_ids=@group_ids, days=@days, time_start=@time_start, time_end=@time_end,
      special_dates=@special_dates, active=@active
    WHERE id=@id
  `).run({ ...msg, id });
}
function deleteScheduledMessage(id) {
  try { db.prepare('DELETE FROM scheduled_message_targets WHERE message_id = ?').run(id); } catch (_) {}
  try { db.prepare('DELETE FROM scheduled_message_log WHERE message_id = ?').run(id); } catch (_) {}
  return db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
}
function toggleScheduledMessage(id, active) {
  return db.prepare('UPDATE scheduled_messages SET active = ? WHERE id = ?').run(active, id);
}
function getTargetTime(messageId, date) {
  const row = db.prepare('SELECT target_time FROM scheduled_message_targets WHERE message_id = ? AND target_date = ?').get(messageId, date);
  return row ? row.target_time : null;
}
function setTargetTime(messageId, date, time) {
  db.prepare('INSERT OR REPLACE INTO scheduled_message_targets (message_id, target_date, target_time) VALUES (?, ?, ?)').run(messageId, date, time);
}
function wasScheduledMessageFiredToday(messageId, date) {
  return !!db.prepare('SELECT 1 FROM scheduled_message_log WHERE message_id = ? AND target_date = ?').get(messageId, date);
}
function logScheduledMessageFired(messageId, date) {
  db.prepare('INSERT INTO scheduled_message_log (message_id, target_date) VALUES (?, ?)').run(messageId, date);
}

// ===== RESPOSTAS AUTOMÁTICAS / GESTÃO DE GRUPOS / WEBHOOKS / CAMPANHAS =====
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_reply_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_type TEXT DEFAULT 'contains',
      keywords TEXT NOT NULL,
      match_mode TEXT DEFAULT 'any',
      case_sensitive INTEGER DEFAULT 0,
      reply_type TEXT DEFAULT 'fixed',
      reply_text TEXT,
      ai_prompt TEXT,
      scope TEXT DEFAULT 'both',
      group_ids TEXT DEFAULT '',
      cooldown_minutes INTEGER DEFAULT 10,
      stop_on_match INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auto_reply_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER,
      chat_id TEXT,
      fired_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_settings (
      group_id TEXT PRIMARY KEY,
      welcome_enabled INTEGER DEFAULT 0,
      welcome_message TEXT DEFAULT 'Bem-vindo(a) ao grupo, {name}! 🎉',
      farewell_enabled INTEGER DEFAULT 0,
      farewell_message TEXT DEFAULT '{name} saiu do grupo. 👋',
      moderation_enabled INTEGER DEFAULT 0,
      blocked_words TEXT DEFAULT '',
      moderation_action TEXT DEFAULT 'delete',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS moderation_strikes (
      group_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      last_violation_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      event TEXT DEFAULT 'message_received',
      secret TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      last_triggered_at TEXT,
      last_status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS webhook_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      message_text TEXT,
      ai_prompt TEXT,
      image_url TEXT,
      target_type TEXT DEFAULT 'groups',
      contact_source TEXT DEFAULT 'known_only',
      delay_min_seconds INTEGER DEFAULT 8,
      delay_max_seconds INTEGER DEFAULT 20,
      status TEXT DEFAULT 'draft',
      next_send_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      target_id TEXT NOT NULL,
      target_name TEXT,
      status TEXT DEFAULT 'pending',
      error TEXT,
      sent_at TEXT
    );
  `);
} catch (_) {}

// Migração aditiva: novos campos de destino (grupo/DM) e moderação avançada em group_settings
for (const stmt of [
  "ALTER TABLE group_settings ADD COLUMN welcome_send_group INTEGER DEFAULT 1",
  "ALTER TABLE group_settings ADD COLUMN welcome_send_dm INTEGER DEFAULT 0",
  "ALTER TABLE group_settings ADD COLUMN farewell_send_group INTEGER DEFAULT 1",
  "ALTER TABLE group_settings ADD COLUMN farewell_send_dm INTEGER DEFAULT 0",
  "ALTER TABLE group_settings ADD COLUMN moderation_send_group INTEGER DEFAULT 1",
  "ALTER TABLE group_settings ADD COLUMN moderation_send_dm INTEGER DEFAULT 0",
  "ALTER TABLE group_settings ADD COLUMN moderation_block_links INTEGER DEFAULT 0",
  "ALTER TABLE group_settings ADD COLUMN moderation_kick_enabled INTEGER DEFAULT 0",
]) {
  try { db.exec(stmt); } catch (_) { /* coluna já existe */ }
}

function addModerationStrike(groupId, participantId) {
  db.prepare(`
    INSERT INTO moderation_strikes (group_id, participant_id, count, last_violation_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(group_id, participant_id) DO UPDATE SET
      count = count + 1, last_violation_at = datetime('now')
  `).run(groupId, participantId);
  const row = db.prepare('SELECT count FROM moderation_strikes WHERE group_id = ? AND participant_id = ?').get(groupId, participantId);
  return row?.count || 0;
}
function resetModerationStrikes(groupId, participantId) {
  return db.prepare('DELETE FROM moderation_strikes WHERE group_id = ? AND participant_id = ?').run(groupId, participantId);
}

// ===== RESPOSTAS AUTOMÁTICAS =====
function getAllAutoReplyRules() {
  return db.prepare('SELECT * FROM auto_reply_rules ORDER BY priority DESC, created_at DESC').all();
}
function getActiveAutoReplyRules() {
  return db.prepare('SELECT * FROM auto_reply_rules WHERE active = 1 ORDER BY priority DESC, created_at DESC').all();
}
function getAutoReplyRuleById(id) {
  return db.prepare('SELECT * FROM auto_reply_rules WHERE id = ?').get(id);
}
function addAutoReplyRule(rule) {
  return db.prepare(`
    INSERT INTO auto_reply_rules (name, trigger_type, keywords, match_mode, case_sensitive, reply_type, reply_text, ai_prompt, scope, group_ids, cooldown_minutes, stop_on_match, priority, active)
    VALUES (@name, @trigger_type, @keywords, @match_mode, @case_sensitive, @reply_type, @reply_text, @ai_prompt, @scope, @group_ids, @cooldown_minutes, @stop_on_match, @priority, @active)
  `).run(rule);
}
function updateAutoReplyRule(id, rule) {
  return db.prepare(`
    UPDATE auto_reply_rules SET
      name=@name, trigger_type=@trigger_type, keywords=@keywords, match_mode=@match_mode,
      case_sensitive=@case_sensitive, reply_type=@reply_type, reply_text=@reply_text, ai_prompt=@ai_prompt,
      scope=@scope, group_ids=@group_ids, cooldown_minutes=@cooldown_minutes, stop_on_match=@stop_on_match,
      priority=@priority, active=@active, updated_at=datetime('now')
    WHERE id=@id
  `).run({ ...rule, id });
}
function deleteAutoReplyRule(id) {
  db.prepare('DELETE FROM auto_reply_log WHERE rule_id = ?').run(id);
  return db.prepare('DELETE FROM auto_reply_rules WHERE id = ?').run(id);
}
function toggleAutoReplyRule(id, active) {
  return db.prepare("UPDATE auto_reply_rules SET active = ?, updated_at = datetime('now') WHERE id = ?").run(active, id);
}
function getLastFiredAt(ruleId, chatId) {
  const row = db.prepare('SELECT fired_at FROM auto_reply_log WHERE rule_id = ? AND chat_id = ? ORDER BY fired_at DESC LIMIT 1').get(ruleId, chatId);
  return row ? row.fired_at : null;
}
function logAutoReplyFired(ruleId, chatId) {
  return db.prepare('INSERT INTO auto_reply_log (rule_id, chat_id) VALUES (?, ?)').run(ruleId, chatId);
}
function wasAutoReplyFiredRecently(ruleId, chatId, minutes) {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM auto_reply_log
    WHERE rule_id = ? AND chat_id = ? AND fired_at > datetime('now', '-' || ? || ' minutes')
  `).get(ruleId, chatId, minutes);
  return result.count > 0;
}

// ===== GESTÃO DE GRUPOS =====
const DEFAULT_GROUP_SETTINGS = {
  welcome_enabled: 0,
  welcome_message: 'Bem-vindo(a) ao grupo, {name}! 🎉',
  welcome_send_group: 1,
  welcome_send_dm: 0,
  farewell_enabled: 0,
  farewell_message: '{name} saiu do grupo. 👋',
  farewell_send_group: 1,
  farewell_send_dm: 0,
  moderation_enabled: 0,
  blocked_words: '',
  moderation_action: 'delete',
  moderation_send_group: 1,
  moderation_send_dm: 0,
  moderation_block_links: 0,
  moderation_kick_enabled: 0,
};
function getGroupSettings(groupId) {
  const row = db.prepare('SELECT * FROM group_settings WHERE group_id = ?').get(groupId);
  return row || { group_id: groupId, ...DEFAULT_GROUP_SETTINGS };
}
function getAllGroupSettings() {
  return db.prepare('SELECT * FROM group_settings').all();
}
function upsertGroupSettings(groupId, settings) {
  const merged = { ...DEFAULT_GROUP_SETTINGS, ...settings, group_id: groupId };
  return db.prepare(`
    INSERT INTO group_settings (
      group_id, welcome_enabled, welcome_message, welcome_send_group, welcome_send_dm,
      farewell_enabled, farewell_message, farewell_send_group, farewell_send_dm,
      moderation_enabled, blocked_words, moderation_action,
      moderation_send_group, moderation_send_dm, moderation_block_links, moderation_kick_enabled,
      updated_at
    )
    VALUES (
      @group_id, @welcome_enabled, @welcome_message, @welcome_send_group, @welcome_send_dm,
      @farewell_enabled, @farewell_message, @farewell_send_group, @farewell_send_dm,
      @moderation_enabled, @blocked_words, @moderation_action,
      @moderation_send_group, @moderation_send_dm, @moderation_block_links, @moderation_kick_enabled,
      datetime('now')
    )
    ON CONFLICT(group_id) DO UPDATE SET
      welcome_enabled=excluded.welcome_enabled, welcome_message=excluded.welcome_message,
      welcome_send_group=excluded.welcome_send_group, welcome_send_dm=excluded.welcome_send_dm,
      farewell_enabled=excluded.farewell_enabled, farewell_message=excluded.farewell_message,
      farewell_send_group=excluded.farewell_send_group, farewell_send_dm=excluded.farewell_send_dm,
      moderation_enabled=excluded.moderation_enabled, blocked_words=excluded.blocked_words,
      moderation_action=excluded.moderation_action,
      moderation_send_group=excluded.moderation_send_group, moderation_send_dm=excluded.moderation_send_dm,
      moderation_block_links=excluded.moderation_block_links, moderation_kick_enabled=excluded.moderation_kick_enabled,
      updated_at=excluded.updated_at
  `).run(merged);
}

// ===== WEBHOOKS =====
function getAllWebhookSubscriptions() {
  return db.prepare('SELECT * FROM webhook_subscriptions ORDER BY created_at DESC').all();
}
function getWebhookSubscriptionById(id) {
  return db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(id);
}
function addWebhookSubscription(sub) {
  return db.prepare(`
    INSERT INTO webhook_subscriptions (name, url, event, secret, active)
    VALUES (@name, @url, @event, @secret, @active)
  `).run(sub);
}
function updateWebhookSubscription(id, sub) {
  return db.prepare(`
    UPDATE webhook_subscriptions SET name=@name, url=@url, event=@event, secret=@secret, active=@active WHERE id=@id
  `).run({ ...sub, id });
}
function deleteWebhookSubscription(id) {
  return db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
}
function toggleWebhookSubscription(id, active) {
  return db.prepare('UPDATE webhook_subscriptions SET active = ? WHERE id = ?').run(active, id);
}
function logWebhookTrigger(id, statusText) {
  return db.prepare("UPDATE webhook_subscriptions SET last_triggered_at = datetime('now'), last_status = ? WHERE id = ?").run(statusText, id);
}
function getAllWebhookTokens() {
  return db.prepare('SELECT * FROM webhook_tokens ORDER BY created_at DESC').all();
}
function addWebhookToken(name, token) {
  return db.prepare('INSERT INTO webhook_tokens (name, token) VALUES (?, ?)').run(name, token);
}
function deleteWebhookToken(id) {
  return db.prepare('DELETE FROM webhook_tokens WHERE id = ?').run(id);
}
function toggleWebhookToken(id, active) {
  return db.prepare('UPDATE webhook_tokens SET active = ? WHERE id = ?').run(active, id);
}
function getWebhookTokenByValue(token) {
  return db.prepare('SELECT * FROM webhook_tokens WHERE token = ?').get(token);
}
function touchWebhookTokenUsage(id) {
  return db.prepare("UPDATE webhook_tokens SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

// ===== CAMPANHAS =====
function getAllCampaigns() {
  return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
}
function getCampaignById(id) {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
}
function getCampaignRecipients(campaignId) {
  return db.prepare('SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY id').all(campaignId);
}
function addCampaign(campaign) {
  return db.prepare(`
    INSERT INTO campaigns (name, message_text, ai_prompt, image_url, target_type, contact_source, delay_min_seconds, delay_max_seconds, status)
    VALUES (@name, @message_text, @ai_prompt, @image_url, @target_type, @contact_source, @delay_min_seconds, @delay_max_seconds, @status)
  `).run(campaign);
}
function addCampaignRecipients(campaignId, targets) {
  const insert = db.prepare('INSERT INTO campaign_recipients (campaign_id, target_id, target_name, status, error) VALUES (?, ?, ?, ?, ?)');
  for (const t of targets) {
    insert.run(campaignId, t.id, t.name || null, t.status || 'pending', t.error || null);
  }
}
function updateCampaignStatus(id, status, extra = {}) {
  const sets = ['status = @status'];
  const params = { id, status };
  if (extra.started_at !== undefined) { sets.push('started_at = @started_at'); params.started_at = extra.started_at; }
  if (extra.finished_at !== undefined) { sets.push('finished_at = @finished_at'); params.finished_at = extra.finished_at; }
  return db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = @id`).run(params);
}
function setCampaignNextSendAt(id, iso) {
  return db.prepare('UPDATE campaigns SET next_send_at = ? WHERE id = ?').run(iso, id);
}
function deleteCampaign(id) {
  db.prepare('DELETE FROM campaign_recipients WHERE campaign_id = ?').run(id);
  return db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
}
function getRunningCampaigns() {
  return db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all();
}
function getNextPendingRecipient(campaignId) {
  return db.prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(campaignId);
}
function markRecipientSent(id) {
  return db.prepare("UPDATE campaign_recipients SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(id);
}
function markRecipientFailed(id, error) {
  return db.prepare("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?").run(error, id);
}
function getCampaignProgress(campaignId) {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM campaign_recipients WHERE campaign_id = ? GROUP BY status').all(campaignId);
  const progress = { total: 0, sent: 0, failed: 0, pending: 0, skipped: 0 };
  for (const r of rows) { progress[r.status] = r.count; progress.total += r.count; }
  const campaign = getCampaignById(campaignId);
  progress.status = campaign ? campaign.status : null;
  return progress;
}

// ===== DIRETÓRIO PRÓPRIO DE GRUPOS CONHECIDOS =====
// Construído a partir de eventos (mensagens recebidas, entrada/saída de membros) em vez de
// depender de client.getChats()/getChatById() — que podem ficar indisponíveis por bugs da
// biblioteca do WhatsApp (aconteceu em 2026, sem correção oficial na época).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS known_groups (
      group_id TEXT PRIMARY KEY,
      nickname TEXT,
      source TEXT DEFAULT 'message',
      message_count INTEGER DEFAULT 0,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch (_) {}

function touchKnownGroup(groupId, source = 'message') {
  db.prepare(`
    INSERT INTO known_groups (group_id, source, message_count, first_seen_at, last_seen_at)
    VALUES (?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(group_id) DO UPDATE SET
      message_count = message_count + 1,
      last_seen_at = datetime('now')
  `).run(groupId, source);
}
function getAllKnownGroups() {
  return db.prepare('SELECT * FROM known_groups ORDER BY last_seen_at DESC').all();
}
function setKnownGroupNicknameIfEmpty(groupId, nickname) {
  return db.prepare(`UPDATE known_groups SET nickname = ? WHERE group_id = ? AND (nickname IS NULL OR nickname = '')`).run(nickname, groupId);
}
function setKnownGroupNickname(groupId, nickname) {
  return db.prepare(`
    INSERT INTO known_groups (group_id, nickname) VALUES (?, ?)
    ON CONFLICT(group_id) DO UPDATE SET nickname = excluded.nickname
  `).run(groupId, nickname);
}
function addManualKnownGroup(groupId) {
  return db.prepare(`
    INSERT INTO known_groups (group_id, source, message_count) VALUES (?, 'manual', 0)
    ON CONFLICT(group_id) DO NOTHING
  `).run(groupId);
}
function deleteKnownGroup(groupId) {
  return db.prepare('DELETE FROM known_groups WHERE group_id = ?').run(groupId);
}

// ===== DIRETÓRIO PRÓPRIO DE CONTATOS CONHECIDOS (1:1, não-grupo) =====
// Baileys não expõe "listar todos os chats" pronto — persistimos o que vemos passar,
// mesmo padrão de known_groups. push_name serve de fallback pra boas-vindas/despedida
// já que Baileys também não tem um "buscar contato pelo ID" direto.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS known_contacts (
      jid TEXT PRIMARY KEY,
      push_name TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch (_) {}

function touchKnownContact(jid, pushName) {
  db.prepare(`
    INSERT INTO known_contacts (jid, push_name, first_seen_at, last_seen_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(jid) DO UPDATE SET
      push_name = COALESCE(excluded.push_name, known_contacts.push_name),
      last_seen_at = datetime('now')
  `).run(jid, pushName || null);
}
function getAllKnownContactIds() {
  return db.prepare('SELECT jid FROM known_contacts').all().map(r => r.jid);
}
function getKnownContactPushName(jid) {
  const row = db.prepare('SELECT push_name FROM known_contacts WHERE jid = ?').get(jid);
  return row?.push_name || null;
}

function getKnownGroupById(groupId) {
  return db.prepare('SELECT * FROM known_groups WHERE group_id = ?').get(groupId);
}

// ===== AUTO-ESCALA DE GRUPOS (SÉRIE) =====
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      member_threshold INTEGER DEFAULT 1000,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS group_series_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      sequence_number INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT,
      invite_code TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch (_) {}

function getAllGroupSeries() {
  return db.prepare('SELECT * FROM group_series ORDER BY created_at DESC').all();
}
function getGroupSeriesById(id) {
  return db.prepare('SELECT * FROM group_series WHERE id = ?').get(id);
}
function addGroupSeries(series) {
  return db.prepare(`
    INSERT INTO group_series (name, member_threshold, active)
    VALUES (@name, @member_threshold, @active)
  `).run(series);
}
function updateGroupSeries(id, series) {
  return db.prepare(`
    UPDATE group_series SET name=@name, member_threshold=@member_threshold, active=@active WHERE id=@id
  `).run({ ...series, id });
}
function getActiveGroupInSeries(seriesId) {
  return db.prepare("SELECT * FROM group_series_groups WHERE series_id = ? AND status = 'active' ORDER BY sequence_number DESC LIMIT 1").get(seriesId);
}
function getGroupSeriesGroups(seriesId) {
  return db.prepare('SELECT * FROM group_series_groups WHERE series_id = ? ORDER BY sequence_number').all(seriesId);
}
function getGroupSeriesGroupByGroupId(groupId) {
  return db.prepare("SELECT * FROM group_series_groups WHERE group_id = ? AND status = 'active'").get(groupId);
}
function addGroupSeriesGroup(row) {
  return db.prepare(`
    INSERT INTO group_series_groups (series_id, sequence_number, group_id, group_name, invite_code, status)
    VALUES (@series_id, @sequence_number, @group_id, @group_name, @invite_code, @status)
  `).run(row);
}
function markGroupSeriesGroupFull(id) {
  return db.prepare("UPDATE group_series_groups SET status = 'full' WHERE id = ?").run(id);
}
function getAllGroupSeriesGroupIds() {
  return db.prepare('SELECT DISTINCT group_id FROM group_series_groups').all().map(r => r.group_id);
}
function deleteGroupSeries(id) {
  db.prepare('DELETE FROM group_series_groups WHERE series_id = ?').run(id);
  return db.prepare('DELETE FROM group_series WHERE id = ?').run(id);
}

// ===== INSTAGRAM: REGRAS DE COMENTÁRIO =====
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instagram_comment_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_type TEXT DEFAULT 'contains',
      keywords TEXT NOT NULL,
      match_mode TEXT DEFAULT 'any',
      case_sensitive INTEGER DEFAULT 0,
      reply_text TEXT NOT NULL,
      series_id INTEGER,
      media_id TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS instagram_comment_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id TEXT NOT NULL,
      rule_id INTEGER,
      replied_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch (_) {}

function getAllInstagramCommentRules() {
  return db.prepare('SELECT * FROM instagram_comment_rules ORDER BY created_at DESC').all();
}
function getActiveInstagramCommentRules() {
  return db.prepare('SELECT * FROM instagram_comment_rules WHERE active = 1 ORDER BY created_at DESC').all();
}
function getInstagramCommentRuleById(id) {
  return db.prepare('SELECT * FROM instagram_comment_rules WHERE id = ?').get(id);
}
function addInstagramCommentRule(rule) {
  return db.prepare(`
    INSERT INTO instagram_comment_rules (name, trigger_type, keywords, match_mode, case_sensitive, reply_text, series_id, media_id, active)
    VALUES (@name, @trigger_type, @keywords, @match_mode, @case_sensitive, @reply_text, @series_id, @media_id, @active)
  `).run(rule);
}
function updateInstagramCommentRule(id, rule) {
  return db.prepare(`
    UPDATE instagram_comment_rules SET
      name=@name, trigger_type=@trigger_type, keywords=@keywords, match_mode=@match_mode,
      case_sensitive=@case_sensitive, reply_text=@reply_text, series_id=@series_id, media_id=@media_id,
      active=@active, updated_at=datetime('now')
    WHERE id=@id
  `).run({ ...rule, id });
}
function deleteInstagramCommentRule(id) {
  return db.prepare('DELETE FROM instagram_comment_rules WHERE id = ?').run(id);
}
function toggleInstagramCommentRule(id, active) {
  return db.prepare("UPDATE instagram_comment_rules SET active = ?, updated_at = datetime('now') WHERE id = ?").run(active, id);
}
function wasCommentAlreadyReplied(commentId) {
  return !!db.prepare('SELECT 1 FROM instagram_comment_log WHERE comment_id = ?').get(commentId);
}
function logCommentReplied(commentId, ruleId) {
  return db.prepare('INSERT INTO instagram_comment_log (comment_id, rule_id) VALUES (?, ?)').run(commentId, ruleId);
}

module.exports = {
  getAllProducts, getActiveProducts, getProductById, getProductByMlId,
  addProduct, updateProduct, deleteProduct, toggleProduct,
  addPostHistory, getPostHistory, getPostsToday, wasPostedRecently, wasPostedRecentlyByMlId, clearHistory,
  addLog, getLogs, clearLogs,
  getSetting, setSetting, getAllSettings,
  isBlocked, unblockProduct,
  getAllScheduledMessages, getScheduledMessageById, addScheduledMessage, updateScheduledMessage,
  deleteScheduledMessage, toggleScheduledMessage,
  getTargetTime, setTargetTime, wasScheduledMessageFiredToday, logScheduledMessageFired,
  // Respostas automáticas
  getAllAutoReplyRules, getActiveAutoReplyRules, getAutoReplyRuleById, addAutoReplyRule, updateAutoReplyRule,
  deleteAutoReplyRule, toggleAutoReplyRule, getLastFiredAt, logAutoReplyFired, wasAutoReplyFiredRecently,
  // Gestão de grupos
  getGroupSettings, getAllGroupSettings, upsertGroupSettings,
  // Webhooks
  getAllWebhookSubscriptions, getWebhookSubscriptionById, addWebhookSubscription, updateWebhookSubscription,
  deleteWebhookSubscription, toggleWebhookSubscription, logWebhookTrigger,
  getAllWebhookTokens, addWebhookToken, deleteWebhookToken, toggleWebhookToken, getWebhookTokenByValue, touchWebhookTokenUsage,
  // Campanhas
  getAllCampaigns, getCampaignById, getCampaignRecipients, addCampaign, addCampaignRecipients,
  updateCampaignStatus, setCampaignNextSendAt, deleteCampaign, getRunningCampaigns,
  getNextPendingRecipient, markRecipientSent, markRecipientFailed, getCampaignProgress,
  // Diretório próprio de grupos conhecidos
  touchKnownGroup, getAllKnownGroups, setKnownGroupNickname, setKnownGroupNicknameIfEmpty, addManualKnownGroup, deleteKnownGroup,
  getKnownGroupById,
  // Diretório próprio de contatos conhecidos
  touchKnownContact, getAllKnownContactIds, getKnownContactPushName,
  // Auto-escala de grupos (série)
  getAllGroupSeries, getGroupSeriesById, addGroupSeries, updateGroupSeries,
  getActiveGroupInSeries, getGroupSeriesGroups, getGroupSeriesGroupByGroupId,
  addGroupSeriesGroup, markGroupSeriesGroupFull, getAllGroupSeriesGroupIds, deleteGroupSeries,
  addModerationStrike, resetModerationStrikes,
  // Instagram: regras de comentário
  getAllInstagramCommentRules, getActiveInstagramCommentRules, getInstagramCommentRuleById,
  addInstagramCommentRule, updateInstagramCommentRule, deleteInstagramCommentRule, toggleInstagramCommentRule,
  wasCommentAlreadyReplied, logCommentReplied,
};