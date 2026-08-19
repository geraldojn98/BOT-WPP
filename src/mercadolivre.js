const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generateMeliLink, searchProductsHtml } = require('./mlAffiliate');

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

  // ── 2. Keywords via busca do site (sessão logada do afiliado) ───────────────
  // A API oficial de busca (api.mercadolibre.com/sites/MLB/search) exige um token com
  // escopo que o app não tem — só dá 401/403, mesmo com o token recém-renovado. A página
  // pública de busca (lista.mercadolivre.com.br) funciona sem token, mas bloqueia acesso
  // anônimo (redireciona pra verificação de conta); com a sessão logada do afiliado
  // (mesma usada pra gerar link meli.la), carrega normal e traz resultados de verdade —
  // já confirmado manualmente com "dji agras" trazendo peças reais do nicho.
  //
  // Sem preço/desconto conhecido nessa etapa (só título e link) — quem confirma preço de
  // verdade é a verificação na página individual de cada produto (passo 4 abaixo), que já
  // não confia em dado não verificado. Por isso essa lista entra sempre como candidatos
  // "sem desconto garantido"; o passo 4 prioriza os que, depois de verificados, batem o
  // desconto sugerido, e só cai pros demais (do nicho, sem desconto) se nenhum bater.
  if (hasKeywords) {
    // Até 6 termos — perfis de nicho (ex: "drones agrícolas, geradores para drone,
    // misturador, motobomba, epi") costumam precisar de vários termos pra cobrir o
    // segmento inteiro, não só o produto principal.
    const terms = keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 6);
    const seenIds = new Set();
    for (const term of terms) {
      try {
        const html = await searchProductsHtml(userId, term);
        let foundHere = 0;
        for (const [, rawHref] of html.matchAll(/href="([^"]+\/p\/MLB[^"]+)"/g)) {
          const catId = rawHref.match(/\/p\/(MLB\d+)/)?.[1];
          const wid = rawHref.match(/wid=(MLB\d+)/)?.[1];
          const mlId = wid || catId;
          if (!catId || !mlId || seenIds.has(mlId)) continue;
          seenIds.add(mlId);
          foundHere++;
          const cleanHref = rawHref.startsWith('http')
            ? rawHref.split('#')[0]
            : `https://www.mercadolivre.com.br${rawHref.split('#')[0]}`;
          candidates.push({
            ml_id: mlId, catalog_id: catId, url: cleanHref,
            title: null, price: null, original_price: null, discount_percent: 0,
            image_url: null, affiliate_url: null, category: null, custom_text: null,
          });
        }
        console.log(`[ML Search] "${term}": ${foundHere} produto(s) encontrados na busca`);
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
  //
  // Importante: se não der pra abrir/confirmar a página real do produto, o candidato é
  // DESCARTADO — não posta com dados só do scraping de /ofertas. Essa raspagem localiza
  // título/preço por proximidade de texto no HTML, e já causou na prática um produto
  // postado com a descrição/preço de OUTRO produto (mesma região da página, itens
  // diferentes). Preferível pular um candidato a arriscar postar a coisa errada.
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
      // Sem acesso à página de verdade do produto, não tem como confirmar que o
      // título/preço raspados de /ofertas realmente são desse mesmo link — a raspagem
      // por proximidade de texto já causou pelo menos um caso real de mismatch (preço e
      // descrição de um produto, link de outro completamente diferente). Descarta em vez
      // de confiar cegamente nos dados não verificados.
      console.log(`[ML] ⚠️ Pulando ${p.ml_id} — erro ao abrir página (${e.message}), sem como confirmar que os dados batem com o link.`);
      return null;
    }

    const body = typeof r.data === 'string' ? r.data : '';

    // Produto confirmadamente indisponível (a página carregou normal e diz isso)
    if (r.status < 400 && (body.includes('anuncio-indisponivel') || body.includes('Anúncio indisponível'))) {
      console.log(`[ML] ❌ Indisponível: ${p.ml_id}`);
      return null;
    }

    // Bloqueio antibot do ML (página de "suspicious traffic") ou erro HTTP — mesmo motivo
    // acima: sem a página real pra conferir, não arrisca postar título/preço não verificados.
    if (r.status >= 400 || body.includes('suspicious-traffic')) {
      console.log(`[ML] ⚠️ Pulando ${p.ml_id} — bloqueado/erro HTTP ${r.status} ao verificar página do produto.`);
      return null;
    }

    // Extrai título, imagem e URL canônica dos meta og: — são 100% do produto correto
    const ogTitle = body.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1]?.trim();
    const ogImage = body.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1];
    const ogUrl   = body.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/)?.[1];

    if (!ogTitle) {
      console.log(`[ML] ⚠️ Pulando ${p.ml_id} — página carregou mas sem meta og:title reconhecível pra confirmar o produto.`);
      return null;
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
      // Já tínhamos o og:title verificado (a página real, confirmada) — mas algo deu
      // errado processando o resto (preço, link de afiliado). Mesmo assim não cai pro
      // título/preço não verificados do scraping; só descarta esse candidato.
      console.log(`[ML] ⚠️ Pulando ${p.ml_id} — erro ao processar página verificada (${e.message}).`);
      return null;
    }
  }

  // Verifica um por um; o primeiro que bater o desconto sugerido já resolve. Se nenhum
  // bater (comum em nichos, onde poucos produtos têm desconto ativo no momento), guarda o
  // primeiro verificado como reserva — melhor postar algo do nicho certo sem desconto do
  // que não postar nada. Limite de tentativas pra não ficar verificando indefinidamente.
  const MAX_VERIFY_ATTEMPTS = 15;
  let fallbackResult = null;
  let attempts = 0;
  for (const p of unique) {
    if (attempts >= MAX_VERIFY_ATTEMPTS) break;
    attempts++;
    const result = await verifyOne(p);
    if (!result) continue;
    if (result.discount_percent >= minDiscount) {
      console.log(`[ML] 🎯 Produto selecionado: ${result.title?.slice(0,50)}`);
      return [result];
    }
    if (!fallbackResult) fallbackResult = result;
  }

  if (fallbackResult) {
    console.log(`[ML] 🎯 Produto selecionado (sem o desconto sugerido, priorizando a palavra-chave): ${fallbackResult.title?.slice(0,50)}`);
    return [fallbackResult];
  }

  console.log(`[ML] Nenhum produto válido encontrado entre ${unique.length} candidatos.`);
  return [];
}

module.exports = { getProductInfo, generateAffiliateLink, fetchPromoProducts, refreshAccessToken };
