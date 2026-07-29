const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const ML_SESSION_DIR = path.join(__dirname, '../data/ml-session');
const LINKBUILDER_URL = 'https://www.mercadolivre.com.br/afiliados/linkbuilder';

let _browser = null;
let _page = null;

// Garante que o browser está aberto e na página correta
async function ensureBrowser() {
  // Testa se o browser/page ainda estão vivos
  if (_browser && _page) {
    try {
      await _page.title();
      return true;
    } catch (_) {
      _browser = null;
      _page = null;
    }
  }

  if (!fs.existsSync(ML_SESSION_DIR)) {
    throw new Error('ML_NOT_LOGGED_IN');
  }

  const launchOpts = {
    headless: true,
    userDataDir: ML_SESSION_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  _browser = await puppeteer.launch(launchOpts);

  _page = await _browser.newPage();
  await _page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  await _page.goto(LINKBUILDER_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  const currentUrl = _page.url();
  if (currentUrl.includes('login') || currentUrl.includes('/jms/')) {
    await _browser.close();
    _browser = null;
    _page = null;
    throw new Error('ML_NOT_LOGGED_IN');
  }

  console.log('[MLAffiliate] Browser iniciado e sessão carregada.');
  return true;
}

/**
 * Gera um link meli.la para a URL do produto.
 * Retorna o short link ou null se não for possível.
 */
async function generateMeliLink(productUrl) {
  const tag = process.env.ML_AFFILIATE_TAG;
  if (!tag || !productUrl) return null;

  try {
    await ensureBrowser();

    const result = await _page.evaluate(async (url, affiliateTag) => {
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
    } else {
      console.error('[MLAffiliate] Erro:', err.message);
      // Reinicia o browser na próxima chamada
      _browser = null;
      _page = null;
    }
    return null;
  }
}

/**
 * Abre um browser VISÍVEL para o usuário fazer login no ML.
 * Deve ser chamado uma única vez pelo painel web.
 * Após o login, a sessão é salva e o bot passa a gerar links automaticamente.
 */
async function setupMlSession() {
  // Fecha instância headless se existir
  if (_browser) { try { await _browser.close(); } catch (_) {} _browser = null; _page = null; }

  // setupMlSession abre um navegador visível para login manual — só funciona em ambiente local
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Login do ML Affiliate não está disponível na nuvem. Configure localmente e faça upload da pasta data/ml-session para o volume do Railway.');
  }
  const setupLaunchOpts = {
    headless: false,
    userDataDir: ML_SESSION_DIR,
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
          await browser.close();
          console.log('[MLAffiliate] ✅ Login detectado! Sessão salva.');
          // Reinicia o browser headless na próxima chamada
          _browser = null;
          _page = null;
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

function isSessionReady() {
  return fs.existsSync(ML_SESSION_DIR);
}

module.exports = { generateMeliLink, setupMlSession, isSessionReady };
