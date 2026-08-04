const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const LINKBUILDER_URL = 'https://www.mercadolivre.com.br/afiliados/linkbuilder';

function legacySessionDir() { return path.join(__dirname, '../data/ml-session'); }
function legacyCookiesFile() { return path.join(__dirname, '../data/ml-cookies.json'); }
function sessionDirFor(userId) { return path.join(__dirname, '../data/ml-session', String(userId)); }
function cookiesFileFor(userId) { return path.join(__dirname, '../data', `ml-cookies-${userId}.json`); }

/**
 * Migração única: a sessão/cookies de afiliado ML de antes do multiusuário
 * ficavam em data/ml-session e data/ml-cookies.json (sem separação por
 * usuário). Se ainda existirem, move pros arquivos do usuário admin.
 */
function migrateLegacyMlSession(adminUserId) {
  if (!adminUserId) return;
  try {
    const newCookies = cookiesFileFor(adminUserId);
    if (fs.existsSync(legacyCookiesFile()) && !fs.existsSync(newCookies)) {
      fs.renameSync(legacyCookiesFile(), newCookies);
      console.log(`[MLAffiliate] Cookies de afiliado ML migrados para o usuário ${adminUserId}.`);
    }
    const newSessionDir = sessionDirFor(adminUserId);
    if (fs.existsSync(legacySessionDir()) && !fs.existsSync(newSessionDir)) {
      fs.mkdirSync(path.dirname(newSessionDir), { recursive: true });
      fs.renameSync(legacySessionDir(), newSessionDir);
      console.log(`[MLAffiliate] Perfil de sessão ML (legado) migrado para o usuário ${adminUserId}.`);
    }
  } catch (err) {
    console.error('[MLAffiliate] Erro ao migrar sessão ML legada:', err.message);
  }
}

// Cache de browser/page por usuário — cada um com sua própria sessão/cookies,
// nunca compartilhando um navegador entre contas de afiliado diferentes.
const browsers = new Map(); // userId -> { browser, page }

// Garante que o browser daquele usuário está aberto e na página correta
async function ensureBrowser(userId) {
  const cached = browsers.get(userId);
  if (cached) {
    try {
      await cached.page.title();
      return cached;
    } catch (_) {
      browsers.delete(userId);
    }
  }

  const cookiesFile = cookiesFileFor(userId);
  const sessionDir = sessionDirFor(userId);
  const hasCookies = fs.existsSync(cookiesFile);
  if (!hasCookies && !fs.existsSync(sessionDir)) {
    throw new Error('ML_NOT_LOGGED_IN');
  }

  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  // Perfil persistido (data/ml-session/<userId>) só é usado como fallback legado — cookies
  // salvos por um Chrome do Windows são criptografados com DPAPI e não podem ser
  // lidos por um Chrome rodando em Linux (ex: container do Railway), então o
  // caminho preferido é sempre re-injetar os cookies (já descriptografados) via CDP.
  if (!hasCookies) launchOpts.userDataDir = sessionDir;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(launchOpts);

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  if (hasCookies) {
    const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
    const client = await page.target().createCDPSession();
    await client.send('Network.setCookies', { cookies });
  }

  await page.goto(LINKBUILDER_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('/jms/')) {
    await browser.close();
    throw new Error('ML_NOT_LOGGED_IN');
  }

  console.log(`[MLAffiliate] (usuário ${userId}) Browser iniciado e sessão carregada.`);
  const entry = { browser, page };
  browsers.set(userId, entry);
  return entry;
}

/**
 * Gera um link meli.la para a URL do produto (usando a sessão de afiliado do
 * usuário indicado). Retorna o short link ou null se não for possível.
 */
async function generateMeliLink(userId, productUrl) {
  const tag = process.env.ML_AFFILIATE_TAG;
  if (!tag || !productUrl) return null;
  const userDb = db.getUserDb(userId);

  try {
    const { page } = await ensureBrowser(userId);

    const result = await page.evaluate(async (url, affiliateTag) => {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/affiliate-program/api/v2/affiliates/createLink');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => resolve({ error: 'xhr_error' });
        xhr.ontimeout = () => resolve({ error: 'timeout' });
        xhr.timeout = 10000;
        xhr.send(JSON.stringify({ urls: [url], tag: affiliateTag }));
      });
    }, productUrl, tag);

    if (result.error) {
      console.log(`[MLAffiliate] Erro XHR: ${result.error}`);
      return null;
    }

    if (result.status !== 200) {
      console.log(`[MLAffiliate] HTTP ${result.status}: ${result.body?.slice(0, 200)}`);
      return null;
    }

    const data = JSON.parse(result.body);
    const item = data?.urls?.[0];

    if (!item || item.error_code || (!item.short_url && !item.url)) {
      console.log(`[MLAffiliate] URL não permitida (código ${item?.error_code}): ${productUrl.slice(0, 80)}`);
      return null;
    }

    const meliLink = item.short_url || item.url;
    console.log(`[MLAffiliate] ✅ Link gerado: ${meliLink}`);
    return meliLink;

  } catch (err) {
    if (err.message === 'ML_NOT_LOGGED_IN') {
      console.warn('[MLAffiliate] ⚠️  Sessão ML não encontrada. Acesse o painel web e clique em "Conectar Afiliados ML".');
      userDb.addLog('warning', 'ml_affiliate', 'Link meli.la não gerado: sessão do afiliado ML não encontrada/expirada.');
    } else {
      console.error('[MLAffiliate] Erro:', err.message);
      userDb.addLog('error', 'ml_affiliate', `Link meli.la não gerado: ${err.message}`);
      // Reinicia o browser na próxima chamada
      browsers.delete(userId);
    }
    return null;
  }
}

/**
 * Abre um browser VISÍVEL para o usuário fazer login no ML.
 * Deve ser chamado uma única vez pelo painel web.
 * Após o login, a sessão é salva e o bot passa a gerar links automaticamente.
 */
async function setupMlSession(userId) {
  // Fecha instância headless se existir
  const cached = browsers.get(userId);
  if (cached) { try { await cached.browser.close(); } catch (_) {} browsers.delete(userId); }

  // setupMlSession abre um navegador visível para login manual — só funciona em ambiente local
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Login do ML Affiliate não está disponível na nuvem. Configure localmente e faça upload do arquivo de cookies para o volume do Railway.');
  }
  const sessionDir = sessionDirFor(userId);
  const setupLaunchOpts = {
    headless: false,
    userDataDir: sessionDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null,
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) setupLaunchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(setupLaunchOpts);

  const page = await browser.newPage();
  await page.goto(LINKBUILDER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('[MLAffiliate] Navegador aberto. Faça login no Mercado Livre...');

  // Aguarda até estar na página de afiliados (não mais no login)
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      try {
        const url = page.url();
        if (url.includes('linkbuilder') && !url.includes('login') && !url.includes('/jms/')) {
          clearInterval(check);
          const client = await page.target().createCDPSession();
          const { cookies } = await client.send('Network.getAllCookies');
          fs.writeFileSync(cookiesFileFor(userId), JSON.stringify(cookies, null, 2));
          await browser.close();
          console.log(`[MLAffiliate] ✅ Login detectado! Sessão salva (${cookies.length} cookies exportados).`);
          browsers.delete(userId); // reinicia o browser headless na próxima chamada
          resolve(true);
        }
      } catch (_) {}
      if (attempts > 120) { // 2 minutos
        clearInterval(check);
        try { await browser.close(); } catch (_) {}
        reject(new Error('Timeout: login não detectado em 2 minutos.'));
      }
    }, 1000);
  });
}

function isSessionReady(userId) {
  return fs.existsSync(cookiesFileFor(userId)) || fs.existsSync(sessionDirFor(userId));
}

module.exports = { generateMeliLink, setupMlSession, isSessionReady, migrateLegacyMlSession };
