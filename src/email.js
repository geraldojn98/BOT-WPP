const axios = require('axios');

// Envio via API do Resend (https://resend.com) — precisa de RESEND_API_KEY.
// RESEND_FROM_EMAIL: em sandbox (sem domínio verificado no Resend), use
// "onboarding@resend.dev" — mas nesse modo o Resend só entrega pro e-mail da
// própria conta Resend, não pra usuários de verdade. Pra vender o app de
// verdade, é preciso verificar um domínio próprio no Resend e usar um
// remetente desse domínio (ex: "naoresponda@seudominio.com").
const RESEND_API_URL = 'https://api.resend.com/emails';

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

async function sendEmail({ to, subject, html }) {
  if (!isConfigured()) {
    // Sem chave configurada (ex: ambiente local) — não derruba o fluxo de
    // cadastro, só avisa no log e mostra o conteúdo pra facilitar teste manual.
    console.warn(`[Email] RESEND_API_KEY não configurada — e-mail NÃO enviado. Destinatário: ${to} | Assunto: ${subject}`);
    console.warn(`[Email] Conteúdo (pra testar manualmente):\n${html}`);
    return { ok: false, skipped: true };
  }

  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  try {
    await axios.post(RESEND_API_URL, { from, to, subject, html }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return { ok: true };
  } catch (err) {
    console.error('[Email] Erro ao enviar via Resend:', err.response?.data || err.message);
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

function verificationEmailHtml(verifyUrl) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color:#222;">🤖 Confirme seu e-mail</h2>
      <p style="color:#444; font-size: 15px; line-height: 1.6;">
        Falta só um passo pra ativar sua conta no ML WhatsApp Bot. Clique no botão abaixo pra confirmar seu e-mail:
      </p>
      <p style="text-align:center; margin: 28px 0;">
        <a href="${verifyUrl}" style="background:#FFE600; color:#000; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block;">
          Confirmar e-mail
        </a>
      </p>
      <p style="color:#888; font-size: 13px; line-height: 1.5;">
        Se o botão não funcionar, copie e cole este link no navegador:<br>
        <a href="${verifyUrl}" style="color:#2980b9;">${verifyUrl}</a>
      </p>
      <p style="color:#888; font-size: 13px;">Esse link expira em 48 horas. Se você não pediu esse cadastro, pode ignorar este e-mail.</p>
    </div>
  `;
}

async function sendVerificationEmail(toEmail, verifyUrl) {
  return sendEmail({
    to: toEmail,
    subject: 'Confirme seu e-mail — ML WhatsApp Bot',
    html: verificationEmailHtml(verifyUrl),
  });
}

module.exports = { isConfigured, sendEmail, sendVerificationEmail };
