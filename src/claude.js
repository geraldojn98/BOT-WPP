async function generatePostText(product, promptOverride = null, userDb = null) {
  // Se tiver chave da Anthropic, usa o Claude
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'sua_chave_aqui') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // promptOverride vem do perfil de postagem (tom próprio); vazio cai pro prompt padrão
    // do usuário (Configurações) — e se nem isso existir, um texto genérico de último recurso.
    const userPrompt = promptOverride || userDb?.getSetting('claude_prompt') || 'Crie uma mensagem de divulgação atraente e persuasiva para o produto abaixo. Use emojis, destaque o desconto e inclua chamada para ação. Máximo 300 caracteres.';
    const productInfo = `
Produto: ${product.title}
Preço atual: R$ ${product.price ? Number(product.price).toFixed(2) : 'N/A'}
${product.original_price ? `Preço original: R$ ${Number(product.original_price).toFixed(2)}` : ''}
${product.discount_percent ? `Desconto: ${product.discount_percent}%` : ''}
${product.custom_text ? `Obs: ${product.custom_text}` : ''}
    `.trim();

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: 'Você é um especialista em marketing de afiliados para o Mercado Livre. IMPORTANTE: NÃO inclua links, URLs ou endereços web na mensagem. NÃO adicione notas técnicas, observações sobre caracteres ou metadados. SEMPRE inclua o preço atual do produto na mensagem (o valor de "Preço atual" informado abaixo) — mesmo quando não houver desconto/preço original pra destacar, o preço em si nunca pode faltar. Gere APENAS o texto promocional.',
      messages: [{ role: 'user', content: `${userPrompt}\n\n${productInfo}` }],
    });
    return message.content[0].text;
  }

  // Modo teste: texto gerado sem IA
  const discount = product.discount_percent ? `🔥 ${product.discount_percent}% OFF!\n` : '';
  const price = product.price ? `💰 Por apenas R$ ${Number(product.price).toFixed(2)}` : '';
  const original = product.original_price ? ` (de R$ ${Number(product.original_price).toFixed(2)})` : '';

  return `${discount}📦 ${product.title}\n${price}${original}\n\n👆 Aproveite essa oferta incrível do Mercado Livre!`;
}

async function generateCustomMessage(prompt, context = {}) {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'sua_chave_aqui') {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const dayNames = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
      const contextStr = [
        `Data: ${context.date || new Date().toLocaleDateString('pt-BR')}`,
        `Dia: ${context.dayName || dayNames[new Date().getDay()]}`,
        context.extra ? `Info: ${context.extra}` : '',
      ].filter(Boolean).join('\n');

      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: 'Você cria mensagens para grupos de WhatsApp. Escreva de forma natural, calorosa e com emojis. Gere APENAS o texto da mensagem, sem aspas, sem prefixos.',
        messages: [{ role: 'user', content: `${prompt}\n\nContexto:\n${contextStr}` }],
      });
      return message.content[0].text.trim();
    } catch (err) {
      console.error('[Claude] Erro ao gerar mensagem personalizada:', err.message);
    }
  }
  // Sem IA, retorna o prompt como está
  return prompt;
}

module.exports = { generatePostText, generateCustomMessage };