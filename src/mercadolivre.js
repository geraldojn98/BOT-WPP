const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generateMeliLink } = require('./mlAffiliate');

const ML_BASE = 'https://api.mercadolibre.com';

// ===== TOKEN AUTO-RENEWAL =====
let _tokenExpiry = 0;

async function refreshAccessToken() {
  const appId = process.env.ML_APP_ID;
  const secret = process.env.ML_CLIENT_SECRET;
  if (!appId || !secret) return;

  try {
    const { data } = await axios.post(`${ML_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: secret,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    process.env.ML_ACCESS_TOKEN = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // renova 5 min antes

    // Persiste no .env para sobreviver a restarts
    const envPath = path.join(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/^ML_ACCESS_TOKEN=.*/m, `ML_ACCESS_TOKEN=${data.access_token}`);
      fs.writeFileSync(envPath, envContent);
    }

    console.log('[ML] ✅ Access Token renovado. Expira em', Math.round(data.expires_in / 60), 'minutos.');
  } catch (err) {
    console.error('[ML] ❌ Erro ao renovar token:', err.message);
  }
}

async function ensureToken() {
  if (Date.now() >= _tokenExpiry) {
    await refreshAccessToken();
  }
}

// Renova automaticamente a cada 5 horas e 50 minutos
setInterval(() => refreshAccessToken(), (5 * 60 + 50) * 60 * 1000);
// Primeira renovação ao iniciar (se as credenciais estiverem configuradas)
if (process.env.ML_APP_ID && process.env.ML_CLIENT_SECRET) {
  refreshAccessToken();
}

/**
 * Busca informações de um produto pelo ID ou URL do ML
 */
async function getProductInfo(mlIdOrUrl) {
  await ensureToken();
  try {
    let mlId = mlIdOrUrl;
    let originalAffiliateUrl = null;

    if (mlIdOrUrl.startsWith('http')) {
      // Guarda o link original (pode ser de afiliado)
      originalAffiliateUrl = mlIdOrUrl;

      // Tenta extrair ID direto da URL
      let match = mlIdOrUrl.match(/MLB\d+/i);

      // Se não encontrou (ex: link encurtado meli.la), segue redirecionamentos manualmente
      if (!match) {
        try {
          let currentUrl = mlIdOrUrl;
          for (let i = 0; i < 6; i++) {
            const resp = await axios.get(currentUrl, {
              maxRedirects: 0,
              validateStatus: s => s < 400,
              timeout: 8000,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            const location = resp.headers?.location;
            if (location) {
              currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
              match = currentUrl.match(/MLB\d+/i);
              if (match) break;
            } else {
              // chegou na URL final, tenta extrair do conteúdo
              match = (resp.config?.url || currentUrl).match(/MLB\d+/i);
              break;
            }
          }
        } catch (e) {
          const redirectUrl = e.response?.headers?.location || '';
          match = redirectUrl.match(/MLB\d+/i);
        }
      }

      if (!match) throw new Error('Não foi possível identificar o produto. Tente copiar o link direto da página do produto no Mercado Livre.');
      mlId = match[0].toUpperCase();
    }

    const headers = {};
    if (process.env.ML_ACCESS_TOKEN && process.env.ML_ACCESS_TOKEN !== 'seu_access_token_aqui') {
      headers.Authorization = `Bearer ${process.env.ML_ACCESS_TOKEN}`;
    }

    const { data } = await axios.get(`${ML_BASE}/items/${mlId}`, { headers });

    const discount = data.original_price
      ? Math.round(((data.original_price - data.price) / data.original_price) * 100)
      : 0;

    return {
      ml_id: data.id,
      title: data.title,
      url: data.permalink,
      affiliate_url: originalAffiliateUrl,  // preserva o link de afiliado original
      price: data.price,
      original_price: data.original_price || null,
      discount_percent: discount,
      image_url: data.thumbnail?.replace('I.jpg', 'O.jpg') || data.thumbnail,
      category: data.category_id,
    };
  } catch (err) {
    if (err.response?.status === 401) {
      throw new Error('Token do Mercado Livre inválido ou expirado.');
    }
    throw err;
  }
}

/**
 * Gera link de afiliado usando a API do ML
 */
async function generateAffiliateLink(url) {
  try {
    const tag = process.env.ML_AFFILIATE_TAG;
    if (!tag || !url) return url;

    // Adiciona parâmetros de rastreamento de afiliado à URL do produto
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}matt_tool=painel-afiliados&matt_word=${tag}&matt_source=bot_whatsapp`;
  } catch {
    return url;
  }
}

/**
 * Busca produtos em promoção via scraping da página de ofertas do ML
 * (contorna restrições da API de busca)
 */
async function fetchPromoProducts({ userId, minDiscount = 20, limit = 50, keywords = '', priceMin = null, priceMax = null, excludeIds = new Set() } = {}) {
  const tag = process.env.ML_AFFILIATE_TAG || '';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0';

  const pMin = priceMin && parseFloat(priceMin) > 0 ? parseFloat(priceMin) : null;
  const pMax = priceMax && parseFloat(priceMax) > 0 ? parseFloat(priceMax) : null;

  let candidates = []; // { ml_id, url (catalog href) }
  let ofertasError = null;
  const hasKeywords = !!(keywords && keywords.trim());

  // Perfil com palavras-chave (nicho, ex: "peças de drone agrícola") — pula a raspagem
  // genérica de /ofertas de propósito. Antes ela sempre rodava e entrava misturada no
  // mesmo balaio de candidatos junto com os resultados da busca por palavra-chave, sorteado
  // sem prioridade nenhuma pra quem tinha keyword — o que fazia um perfil nichado às vezes
  // acabar postando qualquer produto aleatório do feed geral de ofertas (ex: "DJI Agras"
  // postando "potes herméticos"). Com keyword definida, só usa os resultados da busca.
  if (!hasKeywords) {
  // ── 1. Raspa /ofertas: extrai ID + título + preço via forward-search ────────
  try {
    const { data: html } = await axios.get('https://www.mercadolivre.com.br/ofertas', {
      headers: { 'User-Agent': UA },
      timeout: 12000,
    });

    const hrefMap = {};
    for (const [, rawHref] of html.matchAll(/href="([^"]+\/p\/MLB[^"]+)"/g)) {
      const cat = rawHref.match(/\/p\/(MLB\d+)/)?.[1];
      const wid = rawHref.match(/wid=(MLB\d+)/)?.[1];
      const cleanHref = rawHref.startsWith('http')
        ? rawHref.split('#')[0]
        : `https://www.mercadolivre.com.br${rawHref.split('#')[0]}`;
      if (cat && !hrefMap[cat]) hrefMap[cat] = { wid: wid || null, url: cleanHref };
    }

    for (const [catId, { wid, url: itemUrl }] of Object.entries(hrefMap)) {
      let found = null;
      for (const searchId of [wid, catId].filter(Boolean)) {
        const idIdx = html.indexOf(`"${searchId}"`);
        if (idIdx === -1) continue;
        // Janela de 4000 chars — suficiente para o bloco do produto, pequena o suficiente para não vazar pro próximo
        const forward = html.slice(idIdx, idIdx + 4000);
        // Layout de preço mudou (mai/2026): "previous_price" agora é uma chave dentro de um
        // componente aninhado ("key":"previous_price",...,"price":{"value":N}), não mais um
        // objeto direto "previous_price":{"value":N}. "current_price" continua direto.
        const prevMatch = forward.match(/"key":"previous_price"[\s\S]{0,300}?"price":\{"value":(\d+(?:\.\d+)?)/);
        const currMatch = forward.match(/"current_price":\{"value":(\d+(?:\.\d+)?)/);
        const titleMatch = forward.match(/"text":"([^"]{10,120})","long_title"/);
        // Layout de imagem também mudou: "pictures":{"pictures":[{"id":"604677-MLA..."}]} em vez de
        // uma "secure_url" completa. O CDN da ML aceita montar a URL final a partir desse ID.
        const imageMatch = forward.match(/"pictures":\{"scale":"[A-Z]+","pictures":\[\{"id":"([^"]+)"/);
        if (prevMatch && currMatch && titleMatch) {
          const imgUrl = imageMatch ? `https://http2.mlstatic.com/D_NQ_NP_2X_${imageMatch[1]}-F.jpg` : null;
          found = {
            mlId: searchId,
            origPrice: parseFloat(prevMatch[1]),
            price: parseFloat(currMatch[1]),
            title: titleMatch[1].replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim(),
            image_url: imgUrl,
          };
          break;
        }
      }
      if (!found) continue;

      const { mlId, origPrice, price, title, image_url: scrapedImage } = found;
      const discount = Math.round(((origPrice - price) / origPrice) * 100);
      if (discount < minDiscount) continue;
      if (pMin && price < pMin) continue;
      if (pMax && price > pMax) continue;

      const sep = itemUrl.includes('?') ? '&' : '?';
      candidates.push({
        ml_id: mlId, catalog_id: catId, url: itemUrl,
        title, price, original_price: origPrice, discount_percent: discount,
        affiliate_url: tag ? `${itemUrl}${sep}matt_tool=painel-afiliados&matt_word=${tag}&matt_source=bot_whatsapp` : itemUrl,
        image_url: scrapedImage || null, category: null, custom_text: null,
      });
    }
    console.log(`[ML Scrape] ofertas: ${candidates.length} candidatos com desconto>=${minDiscount}%`);
  } catch (err) {
    console.error('[ML Scrape] Erro em /ofertas:', err.message);
    ofertasError = err;
  }
  }

  // ── 2. Keywords via ML Search API ────────────────────────────────────────
  if (hasKeywords) {
    // Até 6 termos — perfis de nicho (ex: "drones agrícolas, geradores para drone,
    // misturador, motobomba, epi") costumam precisar de vários termos pra cobrir o
    // segmento inteiro, não só o produto principal.
    const terms = keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 6);
    const authHeaders = process.env.ML_ACCESS_TOKEN && process.env.ML_ACCESS_TOKEN !== 'seu_access_token_aqui'
      ? { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` } : {};
    for (const term of terms) {
      try {
        const { data } = await axios.get(
          `${ML_BASE}/sites/MLB/search?q=${encodeURIComponent(term)}&condition=new&sort=relevance&limit=30`,
          { headers: authHeaders, timeout: 10000 }
        );
        for (const item of (data.results || [])) {
          if (!item.original_price || item.original_price <= item.price) continue;
          const disc = Math.round(((item.original_price - item.price) / item.original_price) * 100);
          if (disc < minDiscount) continue;
          if (pMin && item.price < pMin) continue;
          if (pMax && item.price > pMax) continue;
          const sep = item.permalink.includes('?') ? '&' : '?';
          candidates.push({
            ml_id: item.id, catalog_id: null, url: item.permalink,
            title: item.title, price: item.price, original_price: item.original_price,
            discount_percent: disc, image_url: item.thumbnail?.replace('I.jpg','O.jpg') || item.thumbnail,
            affiliate_url: tag ? `${item.permalink}${sep}matt_tool=painel-afiliados&matt_word=${tag}&matt_source=bot_whatsapp` : item.permalink,
            category: null, custom_text: null,
          });
        }
        console.log(`[ML Search] "${term}": ${data.results?.length || 0} resultados`);
      } catch (err) {
        console.error(`[ML Search] Erro para "${term}":`, err.message);
      }
    }
  }

  // Se a raspagem de /ofertas falhou (bloqueio antibot, rede, etc.) e não sobrou nenhum
  // candidato de outra fonte, é um erro real — diferente de "raspou certinho mas não achou
  // nada com esse filtro". Distinguir isso ajuda a diagnosticar em vez de mostrar sempre a
  // mesma mensagem genérica de "nenhum produto encontrado".
  if (!candidates.length && ofertasError) {
    const status = ofertasError.response?.status;
    if (status === 403 || status === 429) {
      throw new Error(`O Mercado Livre bloqueou temporariamente o acesso à página de ofertas (HTTP ${status}). Costuma ser um bloqueio antibot temporário por volume de requisições — aguarde alguns minutos antes de tentar de novo.`);
    }
    throw new Error(`Não consegui acessar a página de ofertas do Mercado Livre agora (${ofertasError.message}). Tente novamente em instantes.`);
  }

  // ── 3. Deduplica, exclui recentes, embaralha ──────────────────────────────
  const seen = new Set();
  let unique = candidates.filter(p => {
    if (seen.has(p.ml_id) || excludeIds.has(p.ml_id)) return false;
    seen.add(p.ml_id);
    return true;
  });
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  console.log(`[ML] ${unique.length} candidatos para verificar...`);

  // ── 4. Verifica um por um buscando dados da PÁGINA DO PRODUTO ───────────────
  // Estratégia: abre a página do catálogo (com wid) e extrai og:title + og:image.
  // Isso evita dependência da API pública (que retorna 403) e garante que
  // título e imagem são exatamente os do produto que o usuário vai ver ao clicar.
  // Preço/desconto vêm do scraping de /ofertas (já filtrado por minDiscount).
  // Monta o resultado a partir dos dados já extraídos na raspagem de /ofertas (título,
  // preço, desconto, imagem quando disponível) — usado quando a verificação na página
  // individual do produto não é possível (bloqueio antibot do ML, timeout, etc.).
  async function buildFromScrapedData(p, reason) {
    console.log(`[ML] ⚠️ ${reason} (${p.ml_id}) — usando dados da raspagem de /ofertas.`);
    const sep = p.url.includes('?') ? '&' : '?';
    const fallbackUrl = tag ? `${p.url}${sep}matt_tool=painel-afiliados&matt_word=${tag}&matt_source=bot_whatsapp` : p.url;
    const meliLink = await generateMeliLink(userId, p.url).catch(() => null);
    return {
      ml_id: p.ml_id,
      title: p.title,
      url: p.url,
      affiliate_url: meliLink || p.affiliate_url || fallbackUrl,
      price: p.price,
      original_price: p.original_price,
      discount_percent: p.discount_percent,
      image_url: p.image_url || null,
      category: null,
      custom_text: null,
    };
  }

  async function verifyOne(p) {
    let r;
    try {
      r = await axios.get(p.url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.mercadolivre.com.br/ofertas' },
        maxRedirects: 5,
        timeout: 10000,
        validateStatus: () => true,
      });
    } catch (e) {
      return buildFromScrapedData(p, `Erro ao abrir página (${e.message})`);
    }

    const body = typeof r.data === 'string' ? r.data : '';

    // Produto confirmadamente indisponível (a página carregou normal e diz isso)
    if (r.status < 400 && (body.includes('anuncio-indisponivel') || body.includes('Anúncio indisponível'))) {
      console.log(`[ML] ❌ Indisponível: ${p.ml_id}`);
      return null;
    }

    // Bloqueio antibot do ML (página de "suspicious traffic") ou erro HTTP — não dá pra
    // confirmar disponibilidade, mas também não há motivo pra descartar o produto: os dados
    // já raspados de /ofertas continuam válidos.
    if (r.status >= 400 || body.includes('suspicious-traffic')) {
      return buildFromScrapedData(p, `Bloqueado/erro HTTP ${r.status} ao verificar página do produto`);
    }

    // Extrai título, imagem e URL canônica dos meta og: — são 100% do produto correto
    const ogTitle = body.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1]?.trim();
    const ogImage = body.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1];
    const ogUrl   = body.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/)?.[1];

    if (!ogTitle) {
      return buildFromScrapedData(p, 'Página carregou mas sem meta og:title reconhecível');
    }

    try {
      // Preço real: tenta extrair do JSON-LD da página, senão usa o do scraping
      let realPrice = p.price;
      let realOrigPrice = p.original_price;
      try {
        const ldMatch = body.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
        if (ldMatch) {
          for (const block of ldMatch) {
            const json = JSON.parse(block.replace(/<\/?script[^>]*>/g, ''));
            const offer = json?.offers || (Array.isArray(json) && json.find(x => x['@type'] === 'Product')?.offers);
            if (offer?.price) { realPrice = parseFloat(offer.price); break; }
          }
        }
      } catch(_) {}

      const realDiscount = realOrigPrice
        ? Math.round(((realOrigPrice - realPrice) / realOrigPrice) * 100)
        : p.discount_percent;

      if (pMin && realPrice < pMin) return null;
      if (pMax && realPrice > pMax) return null;

      // URL final: usa og:url (permalink limpo) se disponível, senão a do scraping
      const productUrl = (ogUrl && ogUrl.includes('mercadolivre')) ? ogUrl : p.url;
      const sep = productUrl.includes('?') ? '&' : '?';
      const fallbackUrl = tag ? `${productUrl}${sep}matt_tool=painel-afiliados&matt_word=${tag}&matt_source=bot_whatsapp` : productUrl;
      const meliLink = await generateMeliLink(userId, productUrl);

      console.log(`[ML] ✅ ${ogTitle.slice(0,40)} | ${realDiscount}% | img:${ogImage?'✅':'❌'} | ${(meliLink||fallbackUrl).slice(0,35)}`);
      return {
        ml_id:            p.ml_id,
        title:            ogTitle,
        url:              productUrl,
        affiliate_url:    meliLink || fallbackUrl,
        price:            realPrice,
        original_price:   realOrigPrice,
        discount_percent: realDiscount,
        image_url:        ogImage || null,
        category:         null,
        custom_text:      null,
      };
    } catch (e) {
      return buildFromScrapedData(p, `Erro ao processar página (${e.message})`);
    }
  }

  for (const p of unique) {
    const result = await verifyOne(p);
    if (result) {
      console.log(`[ML] 🎯 Produto selecionado: ${result.title?.slice(0,50)}`);
      return [result];
    }
  }

  console.log(`[ML] Nenhum produto válido encontrado entre ${unique.length} candidatos.`);
  return [];
}

module.exports = { getProductInfo, generateAffiliateLink, fetchPromoProducts, refreshAccessToken };
