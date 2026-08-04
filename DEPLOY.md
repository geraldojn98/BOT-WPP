# Deploy no Railway — Guia Passo a Passo

## 1. Pré-requisitos

- Conta no [Railway](https://railway.app) (gratuita para começar)
- Repositório no GitHub com o código do bot

---

## 2. Suba o código para o GitHub

Se ainda não fez, adicione os novos arquivos e faça push:

```bash
git add .
git commit -m "feat: add Railway deploy config + mobile UI + basic auth"
git push origin main
```

---

## 3. Crie o projeto no Railway

1. Acesse [railway.app](https://railway.app) e faça login
2. Clique em **"New Project"** → **"Deploy from GitHub repo"**
3. Selecione o repositório `ml-whatsapp-bot`
4. Railway vai detectar o `Dockerfile` automaticamente e iniciar o build

---

## 4. Configure as variáveis de ambiente

No painel do Railway: **Service → Variables → Add Variable**

| Variável | Valor | Obrigatório |
|----------|-------|-------------|
| `PANEL_USER` | Usado só na primeira vez, pra criar sua conta de login automaticamente (ex: `admin`) | Opcional |
| `PANEL_PASS` | Senha dessa primeira conta (ex: `minhasenha123`) | Opcional |
| `ANTHROPIC_API_KEY` | Sua chave da API Anthropic | Recomendado |
| `ML_APP_ID` | ID do app Mercado Livre | Opcional |
| `ML_CLIENT_SECRET` | Secret do app ML | Opcional |
| `ML_AFFILIATE_TAG` | Sua tag de afiliado ML | Opcional |
| `ML_ACCESS_TOKEN` | Token de acesso ML | Opcional |
| `INSTAGRAM_PAGE_ID` | ID da Página do Facebook vinculada ao Instagram | Só p/ automação de Instagram |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | Page Access Token de longa duração | Só p/ automação de Instagram |
| `INSTAGRAM_APP_SECRET` | App Secret do app criado na Meta | Só p/ automação de Instagram |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Um texto aleatório escolhido por você | Só p/ automação de Instagram |
| `RESEND_API_KEY` | Chave da API do [Resend](https://resend.com), usada pra mandar o e-mail de confirmação de cadastro | Sim, pra autocadastro funcionar |
| `RESEND_FROM_EMAIL` | E-mail remetente (ver nota abaixo) | Opcional (usa `onboarding@resend.dev` se não definir) |
| `PORT` | `3000` | Auto (Railway define) |

> ⚠️ **Login:** o painel agora tem tela de login própria com autocadastro **por e-mail**
> — qualquer pessoa com o link consegue criar a própria conta (confirmando o e-mail
> antes de poder entrar) e conectar seu próprio WhatsApp, totalmente isolado dos outros
> usuários. `PANEL_USER`/`PANEL_PASS` só servem pra criar a primeira conta
> automaticamente (a sua) na primeira vez que o app sobe; depois disso não têm mais
> efeito — pra trocar sua senha, é pela própria tela de login/cadastro.

> ⚠️ **E-mail de confirmação (Resend):**
> 1. Crie uma conta em [resend.com](https://resend.com) e gere uma API key em
>    **API Keys → Create API Key**. Coloque em `RESEND_API_KEY`.
> 2. **Modo sandbox (padrão, sem configurar nada):** usando `onboarding@resend.dev`
>    como remetente, o Resend só entrega e-mails pro endereço cadastrado na SUA
>    própria conta Resend — funciona pra você testar, mas **outras pessoas que se
>    cadastrarem não vão receber o e-mail de confirmação**.
> 3. **Pra vender o app de verdade** (qualquer pessoa consiga se cadastrar e receber
>    o e-mail): em **Domains → Add Domain** no Resend, verifique um domínio seu
>    (adiciona uns registros DNS — o Resend mostra o passo a passo). Depois, defina
>    `RESEND_FROM_EMAIL` como algo desse domínio, ex: `naoresponda@seudominio.com`.
> 4. Sem `RESEND_API_KEY` configurada (ex: rodando local), o bot não trava — só
>    registra o link de confirmação no log do servidor em vez de mandar e-mail de
>    verdade, pra dar pra testar o cadastro sem precisar configurar isso localmente.

---

## 5. Configure o Volume persistente (ESSENCIAL)

O bot precisa salvar o banco de dados (`data/bot.db`) e a sessão do WhatsApp (`data/baileys-auth/`, uns arquivos JSON pequenos — bem mais leve que a sessão antiga baseada em navegador) entre deploys.

1. No painel Railway: **Service → Volumes → Add a Volume**
2. **Mount Path:** `/app/data`
3. Clique em **Save**

> Sem isso, toda vez que o Railway reiniciar o container, você perde os dados e precisa escanear o QR Code novamente.

---

## 6. Configure o domínio

1. **Service → Settings → Networking → Generate Domain**
2. Railway vai te dar uma URL tipo `seu-bot.railway.app`
3. Acesse essa URL no celular para controlar o bot

---

## 7. Conecte o WhatsApp

1. Acesse `https://seu-bot.railway.app` no celular ou computador
2. Vá na aba **Início** — o QR Code vai aparecer
3. Escaneie com o WhatsApp: **⋮ → Aparelhos conectados → Conectar aparelho**
4. Pronto! O bot está conectado e rodando 24/7 na nuvem

---

## 8. Instalar como app no celular (opcional)

Para controlar o bot direto do ícone na tela inicial do smartphone:

**Android (Chrome):**
1. Abra `https://seu-bot.railway.app` no Chrome
2. Toque no menu **⋮ → Adicionar à tela inicial**
3. O app aparece na sua tela inicial como um app nativo

**iPhone (Safari):**
1. Abra a URL no Safari
2. Toque em **Compartilhar → Adicionar à Tela de Início**

---

## 9. Sessão de Afiliados ML (meli.la)

O login do afiliado ML requer um navegador visível — isso só funciona localmente.

Depois do login local, o bot exporta automaticamente os cookies da sessão (já
descriptografados, via CDP) para `data/ml-cookies.json`. **É só esse arquivo que
precisa ir para o Railway** — não a pasta `data/ml-session/` inteira.

> Por quê: o Chrome criptografa os cookies salvos em disco com uma chave do
> sistema operacional (DPAPI no Windows). Copiar a pasta `ml-session/` gerada
> no Windows direto pro container Linux do Railway **não funciona** — os
> arquivos existem, mas o Chrome do Linux não consegue decifrá-los, então o
> bot silenciosamente cai pra "não logado". Injetar os cookies já decifrados
> via `ml-cookies.json` resolve isso pra sempre, além de ser um arquivo bem
> menor e sem risco de ficar travado por outro processo.

**Fluxo recomendado:**
1. Execute o bot localmente (`npm start`)
2. Vá em **Configurações → Conectar Afiliados ML** e faça o login
3. Após login, `data/ml-cookies.json` é gerado automaticamente
4. Faça upload desse arquivo para o volume do Railway via CLI (comando testado e funcional em julho/2026 — a sintaxe da CLI muda com frequência, ajuste se necessário):

```bash
npm install -g @railway/cli
railway login
railway link   # se ainda não estiver linkado ao projeto nesta pasta

railway volume --service <nome-do-servico> files --volume <nome-do-volume> \
  upload ./data/ml-cookies.json /ml-cookies.json --overwrite

railway restart --service <nome-do-servico> --yes
```

> ⚠️ **Cuidado com o botão "Desconectar afiliado" no painel**: ele apaga
> `ml-cookies.json` (e a pasta `ml-session` legada, se existir). Na nuvem,
> reconectar exige repetir esse fluxo manual (login local + reupload) — **não
> é auto-serviço como localmente**, já que "Conectar Afiliados ML" precisa de
> navegador visível e é bloqueado automaticamente quando `NODE_ENV=production`.
> Só desconecte se for realmente trocar de conta.
>
> Os cookies do ML duram bastante tempo (anos), mas se um dia a sessão cair
> na nuvem, repita o mesmo fluxo: login local → `ml-cookies.json` novo →
> reupload → restart.

---

## Configurar Instagram (Meta API) — comentário → DM automática

Essa automação usa a API oficial da Meta ("Private Replies"), não uma lib não-oficial. É gratuita, mas exige configuração manual no painel da Meta antes de funcionar. **Só funciona com o servidor publicado** (Railway) — a Meta não aceita `localhost` como URL de webhook.

1. **Conta Instagram profissional** (Business ou Creator) vinculada a uma **Página do Facebook**. Se ainda não tiver, crie a Página em facebook.com/pages/create e vincule em Instagram → Configurações → Contas vinculadas.
2. Crie um app em [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Criar app** → tipo "Negócios". Adicione os produtos **Instagram** e **Messenger**.
3. Em **Messenger → Configurações**, gere um **Page Access Token** para a Página vinculada (fica em `INSTAGRAM_PAGE_ACCESS_TOKEN`). O ID da Página fica em `INSTAGRAM_PAGE_ID`.
4. Em **Configurações do app → Básico**, copie o **App Secret** (`INSTAGRAM_APP_SECRET`).
5. Escolha um texto aleatório qualquer para `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (você mesmo inventa esse valor).
6. Em **Messenger → Configurações → Webhooks**, configure:
   - **URL de callback:** `https://SEU_DOMINIO.railway.app/api/instagram/webhook`
   - **Token de verificação:** o mesmo valor de `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`
   - **Campos de assinatura:** marque `comments` no objeto Instagram
7. Solicite as permissões `instagram_manage_comments` e `pages_messaging`. Como o app só vai operar a sua própria conta, o acesso "Standard" costuma bastar sem precisar do processo completo de App Review — confirme isso na tela de permissões do seu app (pode variar).
8. Configure as 4 variáveis no Railway (tabela acima) e reinicie o serviço.
9. No painel do bot, aba **📸 Instagram**, confira se todas aparecem com ✅ em "Status da conexão com a Meta", crie a regra de comentário (ex: palavra-chave "eu quero") e vincule à série de grupos criada na aba **Grupos → Auto-escala de grupos**.

**Restrições importantes da Meta:** a resposta automática só pode ser enviada em até **7 dias** após o comentário, e só é permitida **uma resposta por comentário** — não dá pra reenviar se a pessoa comentar de novo na mesma publicação com o mesmo comentário já respondido.

---

## Custos estimados

| Plano | Preço | Adequado para |
|-------|-------|---------------|
| Hobby (gratuito) | $0/mês + $5 crédito inicial | Testes e validação |
| Hobby pago | ~$5–10/mês | 1 bot rodando 24/7 |
| Pro | $20/mês | Múltiplos bots / SaaS |

---

## Troubleshooting

**O container não inicia:**
- Verifique os logs em **Service → Deployments → View Logs**
- Certifique-se que o volume está montado em `/app/data`

**WhatsApp desconecta sozinho:**
- Normal se não tiver volume configurado — configure o volume e reconecte
- O bot tenta reconectar sozinho automaticamente em quedas de conexão comuns. Só pede um QR Code novo se o WhatsApp encerrar a sessão de verdade (ex: você removeu o "aparelho conectado" pelo celular, ou clicou em "Desconectar" no painel)

**"Erro ao buscar produto":**
- Configure as variáveis ML no painel do Railway
