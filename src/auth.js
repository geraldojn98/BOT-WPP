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

function signup(username, password) {
  username = (username || '').trim();
  if (!username || username.length < 3) throw new Error('Usuário precisa ter pelo menos 3 caracteres.');
  if (!password || password.length < MIN_PASSWORD_LEN) throw new Error(`Senha precisa ter pelo menos ${MIN_PASSWORD_LEN} caracteres.`);
  if (db.getUserByUsername(username)) throw new Error('Esse usuário já existe.');

  const hash = hashPassword(password);
  const result = db.createUser(username, hash);
  return db.getUserById(result.lastInsertRowid);
}

function login(username, password) {
  const user = db.getUserByUsername((username || '').trim());
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    throw new Error('Usuário ou senha incorretos.');
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
function requireAuthApi(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = db.getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  req.userId = user.id;
  req.username = user.username;
  next();
}

// Middleware pra rota estática raiz — sem sessão válida, manda pro login.
function requireAuthPage(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = db.getSessionUser(token);
  if (!user) return res.redirect('/login.html');
  req.userId = user.id;
  req.username = user.username;
  next();
}

module.exports = {
  COOKIE_NAME, hashPassword, verifyPassword, checkRateLimit,
  signup, login, setSessionCookie, clearSessionCookie,
  requireAuthApi, requireAuthPage,
};
