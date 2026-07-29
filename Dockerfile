FROM node:22-slim

# Instala Chromium e dependências para Puppeteer (usado só pelo mlAffiliate.js, login
# de afiliados do Mercado Livre — a conexão com o WhatsApp em si usa Baileys, sem navegador)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    fonts-noto-color-emoji \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Diz ao Puppeteer para usar o Chromium do sistema (não baixar o próprio)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Instala dependências Node primeiro (cacheia camadas)
COPY package*.json ./
RUN npm ci --only=production

# Copia o restante do código
COPY . .

# Garante que o diretório de dados existe
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "--experimental-sqlite", "src/server.js"]
