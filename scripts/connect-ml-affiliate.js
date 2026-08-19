require('dotenv').config();
const path = require('path');
const { execSync } = require('child_process');
const { setupMlSession } = require('../src/mlAffiliate');

// Conta principal (GeraldoADM / geraldojn98@gmail.com) no banco de produção.
const USER_ID = 1;
const SERVICE = 'ml-whatsapp-bot';
const VOLUME = 'ml-whatsapp-bot-volume';

async function main() {
  console.log('==========================================================');
  console.log(' Conectar conta de afiliado do Mercado Livre');
  console.log('==========================================================');
  console.log('Uma janela do Chrome vai abrir agora. Faça login normalmente');
  console.log('no Mercado Livre (inclusive qualquer verificação de segurança');
  console.log('que aparecer, tipo código por SMS/e-mail). Não feche a janela');
  console.log('sozinho — o script detecta quando o login terminou.\n');

  try {
    await setupMlSession(USER_ID);
  } catch (err) {
    console.error('\n❌ Não deu certo:', err.message);
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Login feito! Sessão salva aqui no seu computador.');
  console.log('Enviando agora pro servidor da nuvem (Railway)...\n');

  const localFile = path.join(__dirname, '..', 'data', `ml-cookies-${USER_ID}.json`);
  const remotePath = `/ml-cookies-${USER_ID}.json`;

  // Ordem das flags importa pro CLI do Railway: --service pertence a "volume",
  // --volume pertence a "files" — colocar as duas depois de "upload" (como estava
  // antes aqui) dá erro "unexpected argument '--service' found".
  const uploadCmd = `railway volume --service ${SERVICE} files --volume ${VOLUME} upload "${localFile}" "${remotePath}" --overwrite`;
  try {
    execSync(uploadCmd, { stdio: 'inherit' });
  } catch (err) {
    console.error('\n⚠️  Login funcionou, mas o envio automático pro Railway falhou.');
    console.error('Rode este comando manualmente pra completar:');
    console.error(uploadCmd);
    process.exitCode = 1;
    return;
  }

  console.log('\nReiniciando o serviço na nuvem pra ele carregar a sessão nova...\n');
  try {
    execSync(`railway restart --service ${SERVICE} --yes`, { stdio: 'inherit' });
  } catch (_) {
    console.log('(não consegui reiniciar sozinho — sem problema, ele carrega a sessão nova no próximo boot natural.)');
  }

  console.log('\n🎉 Pronto! Sua conta de afiliado do Mercado Livre está conectada de novo.');
}

main();
