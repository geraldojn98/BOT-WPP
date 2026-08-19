require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { setupMlSession } = require('../src/mlAffiliate');

// A mesma conta de afiliado do Mercado Livre (mesma tag, configurada globalmente por
// ML_AFFILIATE_TAG) é reaproveitada pra todas as contas do painel abaixo — assim não
// importa qual delas você está logado no site, a sessão já está pronta pras duas.
// GeraldoADM/geraldojn98@gmail.com (1) e geraldojunior23@yahoo.com.br (7).
const USER_IDS = [1, 7];
const SERVICE = 'ml-whatsapp-bot';
const VOLUME = 'ml-whatsapp-bot-volume';

function localCookiesFile(userId) {
  return path.join(__dirname, '..', 'data', `ml-cookies-${userId}.json`);
}

async function main() {
  console.log('==========================================================');
  console.log(' Conectar conta de afiliado do Mercado Livre');
  console.log('==========================================================');
  console.log('Uma janela do Chrome vai abrir agora. Faça login normalmente');
  console.log('no Mercado Livre (inclusive qualquer verificação de segurança');
  console.log('que aparecer, tipo código por SMS/e-mail). Não feche a janela');
  console.log('sozinho — o script detecta quando o login terminou.\n');

  const primaryUserId = USER_IDS[0];
  try {
    await setupMlSession(primaryUserId);
  } catch (err) {
    console.error('\n❌ Não deu certo:', err.message);
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Login feito! Sessão salva aqui no seu computador.');

  // Copia a mesma sessão pras outras contas do painel, já que é a mesma conta ML.
  const primaryFile = localCookiesFile(primaryUserId);
  for (const userId of USER_IDS.slice(1)) {
    try { fs.copyFileSync(primaryFile, localCookiesFile(userId)); } catch (_) {}
  }

  console.log('Enviando agora pro servidor da nuvem (Railway)...\n');

  // Ordem das flags importa pro CLI do Railway: --service pertence a "volume",
  // --volume pertence a "files" — colocar as duas depois de "upload" dá erro
  // "unexpected argument '--service' found".
  let anyFailed = false;
  for (const userId of USER_IDS) {
    const localFile = localCookiesFile(userId);
    const remotePath = `/ml-cookies-${userId}.json`;
    const uploadCmd = `railway volume --service ${SERVICE} files --volume ${VOLUME} upload "${localFile}" "${remotePath}" --overwrite`;
    try {
      execSync(uploadCmd, { stdio: 'inherit' });
    } catch (err) {
      anyFailed = true;
      console.error(`\n⚠️  Envio da conta ${userId} falhou. Rode manualmente:`);
      console.error(uploadCmd);
    }
  }
  if (anyFailed) {
    process.exitCode = 1;
    return;
  }

  console.log('\nReiniciando o serviço na nuvem pra ele carregar a sessão nova...\n');
  try {
    execSync(`railway restart --service ${SERVICE} --yes`, { stdio: 'inherit' });
  } catch (_) {
    console.log('(não consegui reiniciar sozinho — sem problema, ele carrega a sessão nova no próximo boot natural.)');
  }

  console.log('\n🎉 Pronto! Sua conta de afiliado do Mercado Livre está conectada de novo (nas duas contas do painel).');
}

main();
