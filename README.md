# 🤖 ML WhatsApp Bot

Bot de afiliados do Mercado Livre que posta automaticamente no seu grupo do WhatsApp, com painel web para gerenciar tudo.

---

## 📋 Pré-requisitos

- Node.js 18+
- Conta no Mercado Livre com app de afiliados criado
- Chave de API da Anthropic (Claude)
- Conta no Railway.app (para deploy na nuvem)

---

## 🚀 Rodando localmente

### 1. Instale as dependências
```bash
npm install
```

### 2. Configure as variáveis de ambiente
```bash
cp .env.example .env
```
Edite o arquivo `.env` com suas chaves.

### 3. Inicie o bot
```bash
npm start
```

### 4. Acesse o painel
Abra http://localhost:3000 no navegador.

### 5. Conecte o WhatsApp
Na tela inicial aparecerá um QR Code. Escaneie com seu WhatsApp:
**Configurações → Aparelhos conectados → Conectar aparelho**

---

## ☁️ Deploy no Railway

### 1. Crie uma conta em railway.app

### 2. Instale o CLI do Railway
```bash
npm install -g @railway/cli
railway login
```

### 3. Faça o deploy
```bash
railway init
railway up
```

### 4. Configure as variáveis de ambiente no Railway
No painel do Railway, vá em **Variables** e adicione todas as variáveis do `.env`.

### 5. Escaneie o QR Code
Acesse a URL gerada pelo Railway e escaneie o QR Code.

---

## 📦 Estrutura do projeto

```
ml-whatsapp-bot/
├── src/
│   ├── server.js       # Servidor Express + rotas da API
│   ├── bot.js          # WhatsApp + agendamento de posts
│   ├── database.js     # SQLite (produtos, histórico, configurações)
│   ├── claude.js       # Geração de texto com Claude AI
│   └── mercadolivre.js # API do Mercado Livre
├── public/
│   └── index.html      # Painel web (frontend)
├── data/               # Banco de dados e sessão do WhatsApp (gerado automaticamente)
├── .env.example        # Exemplo de variáveis de ambiente
├── package.json
└── railway.json        # Configuração de deploy
```

---

## 🔑 Como obter as chaves

### Anthropic (Claude)
1. Acesse https://console.anthropic.com
2. Crie uma API Key

### Mercado Livre
1. Acesse https://developers.mercadolivre.com.br
2. Crie um app em "Criar aplicação"
3. Pegue o `App ID` e `Client Secret`
4. Gere um `Access Token` com permissões de afiliados

---

## ⚙️ Configurações no painel

- **ID do Grupo**: Envie qualquer mensagem pro grupo e veja nos logs do servidor o ID (formato: `XXXXXXXXXXX@g.us`)
- **Horário cron**: Use https://crontab.guru para montar seu horário
- **Prompt do Claude**: Personalize o texto que o Claude vai gerar para cada produto

---

## ⚠️ Avisos importantes

- A Baileys é uma biblioteca **não-oficial** de WhatsApp. Use com moderação para evitar bloqueio.
- Não envie spam. Respeite os intervalos configurados.
- Siga sempre as regras de afiliados do Mercado Livre.
