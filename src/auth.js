const bcrypt = require('bcryptjs');
const db = require('./database');

const COOKIE_NAME = 'session';
const MIN_PASSWORD_LEN = 6;

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

// Rate limit simples em memória — única barreira contra abuso num endpoint
// de autocadastro/login aberto. Reseta se o processo reiniciar; suficiente
// pra desencorajar tentativa automatizada básica, não é uma solução robusta.
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cadastro por e-mail: cria a conta já pedindo confirmação — quem chama
// (server.js) é responsável por gerar o token de verificação e mandar o
// e-mail. Se já existe uma conta com esse e-mail mas ainda não confirmada,
// devolve ela mesma (isNew:false) em vez de travar — permite reenviar a
// confirmação sem obrigar a pessoa a usar outro e-mail.
function signup(email, password) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('Informe um e-mail válido.');
  if (!password || password.length < MIN_PASSWORD_LEN) throw new Error(`Senha precisa ter pelo menos ${MIN_PASSWORD_LEN} caracteres.`);

  const existing = db.getUserByEmail(email);
  if (existing) {
    if (existing.email_verified) throw new Error('Já existe uma conta com esse e-mail — faça login.');
    return { user: existing, isNew: false };
  }

  const hash = hashPassword(password);
  const result = db.createUserWithEmail(email, hash);
  return { user: db.getUserById(result.lastInsertRowid), isNew: true };
}

// Login aceita e-mail (contas novas) ou usuário (contas legadas criadas antes
// do cadastro por e-mail existir, ex: a partir de PANEL_USER).
function login(identifier, password) {
  const user = db.getUserByIdentifier(identifier);
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    throw new Error('E-mail/usuário ou senha incorretos.');
  }
  // Contas legadas (sem e-mail cadastrado) nunca passaram pelo fluxo de
  // confirmação — só bloqueia quem tem e-mail e ainda não confirmou.
  if (user.email && !user.email_verified) {
    const err = new Error('Confirme seu e-mail antes de entrar — verifique sua caixa de entrada (e o spam).');
    err.emailNotVerified = true;
    throw err;
  }
  return user;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Middleware pras rotas /api/* — exige sessão válida, responde 401 se não tiver.
// Anexa req.userDb (banco isolado desse usuário) além de req.userId — as rotas
// usam req.userDb.* em vez do antigo db.* global, e nunca enxergam dado de outro usuário.
function requireAuthApi(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = db.getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  req.userId = user.id;
  req.username = user.email || user.username;
  req.userDb = db.getUserDb(user.id);
  next();
}

// Middleware pra rota estática raiz — sem sessão válida, manda pro login.
function requireAuthPage(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = db.getSessionUser(token);
  if (!user) return res.redirect('/login.html');
  req.userId = user.id;
  req.username = user.email || user.username;
  next();
}

module.exports = {
  COOKIE_NAME, hashPassword, verifyPassword, checkRateLimit,
  signup, login, setSessionCookie, clearSessionCookie,
  requireAuthApi, requireAuthPage,
};
