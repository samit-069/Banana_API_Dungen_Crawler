// server.js - Banana Quest backend using only Node's built-in modules (no npm packages). Own code.
//
//   Virtual identity : register/login, scrypt password hashes, HttpOnly SameSite cookie, login lockout
//   Events           : HTTP request events drive the server; the game engine emits its own events
//   Interoperability : banana.js (third-party REST/JSON) feeds puzzles into combat
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const game = require('./game');
const banana = require('./banana');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_FAILS = 5, LOCK_MS = 5 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };

// ---------- Virtual identity ----------
const sessions = new Map();   // token -> { username, expires, run }
const failures = new Map();   // username -> { count, until }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function startSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex');      // 256-bit unguessable id
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS, run: null });
  // HttpOnly: scripts cannot read it (limits XSS damage). SameSite=Strict: browser will not send it
  // on cross-site requests (limits CSRF). Add "Secure" once served over HTTPS.
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function getSession(req) {
  const token = parseCookies(req).sid;
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return { token, s };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, rec) {
  const attempt = crypto.scryptSync(password, rec.salt, 64);
  const expected = Buffer.from(rec.hash, 'hex');
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

function validCreds(b) {
  return b && typeof b.username === 'string' && typeof b.password === 'string' &&
    /^[A-Za-z0-9_]{3,20}$/.test(b.username) && b.password.length >= 6 && b.password.length <= 100;
}

// ---------- Helpers ----------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 10000) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function requireRun(ctx) {
  if (!ctx.s.run) throw Object.assign(new Error('No active run. Start a new adventure.'), { status: 404 });
  return ctx.s.run;
}

function newRun(username) {
  const run = game.createRun(username);
  // EVENT: when the engine reports the run is over, save the result exactly once.
  run.events.on('runOver', result => {
    if (!run.recorded) { run.recorded = true; store.recordRun(username, result); }
  });
  return run;
}

// ---------- Routes: "METHOD /path" -> { auth, handler } ----------
const routes = {
  'POST /api/register': { handler: async (ctx, res) => {
    if (!validCreds(ctx.body)) return send(res, 400, { error: 'Username 3-20 letters/digits/_, password 6+ chars' });
    if (!store.createUser(ctx.body.username, hashPassword(ctx.body.password))) {
      return send(res, 409, { error: 'Username already taken' });
    }
    startSession(res, ctx.body.username);
    send(res, 200, { username: ctx.body.username });
  } },

  'POST /api/login': { handler: async (ctx, res) => {
    if (!validCreds(ctx.body)) return send(res, 400, { error: 'Invalid credentials format' });
    const key = ctx.body.username.toLowerCase();
    const f = failures.get(key);
    if (f && f.until > Date.now()) return send(res, 429, { error: 'Too many failed attempts. Try again later.' });
    const user = store.getUser(key);
    if (!user || !verifyPassword(ctx.body.password, user.password)) {
      const cur = f && !(f.until && f.until <= Date.now()) ? f : { count: 0, until: 0 };   // fresh counter once a lock expires
      cur.count++;
      if (cur.count >= MAX_FAILS) { cur.until = Date.now() + LOCK_MS; cur.count = 0; }
      failures.set(key, cur);
      return send(res, 401, { error: 'Wrong username or password' });   // same message: no username enumeration
    }
    failures.delete(key);
    startSession(res, user.username);
    send(res, 200, { username: user.username });
  } },

  'POST /api/logout': { auth: true, handler: async (ctx, res) => {
    sessions.delete(ctx.token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    send(res, 200, { ok: true });
  } },

  'GET /api/me': { auth: true, handler: async (ctx, res) => {
    const u = store.getUser(ctx.s.username);
    send(res, 200, { username: u.username, bestScore: u.bestScore, bestFloor: u.bestFloor, wins: u.wins, runs: u.runs });
  } },

  'GET /api/leaderboard': { handler: async (ctx, res) => send(res, 200, store.leaderboard()) },

  'GET /api/run': { auth: true, handler: async (ctx, res) =>
    send(res, 200, { run: ctx.s.run ? game.view(ctx.s.run) : null }) },

  'POST /api/run/new': { auth: true, handler: async (ctx, res) => {
    ctx.s.run = newRun(ctx.s.username);
    send(res, 200, { run: game.view(ctx.s.run) });
  } },

  // Step 1 of a turn: choose an action. Puzzle actions fetch puzzles from the Banana API.
  'POST /api/run/action': { auth: true, handler: async (ctx, res) => {
    const run = requireRun(ctx);
    let started;
    try {
      started = await game.startAction(run, String(ctx.body.action), banana.fetchPuzzles);
    } catch (e) {
      if (!e.status) { console.error('Banana API error:', e.message); e.status = 502; e.message = 'Puzzle service unavailable - no turn used, try again.'; }
      throw e;
    }
    send(res, 200, { puzzles: started.puzzles, seconds: started.seconds, run: game.view(run) });
  } },

  // Step 2 of a turn: submit answers (server checks them and the timer).
  'POST /api/run/answer': { auth: true, handler: async (ctx, res) => {
    const run = requireRun(ctx);
    const result = game.answer(run, ctx.body.answers);
    send(res, 200, { result, run: game.view(run) });
  } },

  'POST /api/run/shop': { auth: true, handler: async (ctx, res) => {
    const run = requireRun(ctx);
    game.buyPotion(run);
    send(res, 200, { run: game.view(run) });
  } },

  'POST /api/run/next': { auth: true, handler: async (ctx, res) => {
    const run = requireRun(ctx);
    game.nextFloor(run);
    send(res, 200, { run: game.view(run) });
  } }
};

// ---------- Static files ----------
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }   // path traversal guard
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Main request handler (the "event" that drives the server) ----------
async function handle(req, res) {
  // Security headers: CSP only allows our own scripts/styles; puzzle images may come from any https host.
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src https: http:; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    const route = routes[`${req.method} ${pathname}`];
    if (route) {
      const ctx = { body: req.method === 'POST' ? await readJson(req) : {} };
      if (route.auth) {
        const sess = getSession(req);
        if (!sess) return send(res, 401, { error: 'Not logged in' });
        ctx.s = sess.s; ctx.token = sess.token;
      }
      return await route.handler(ctx, res);
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    if (!e.status) console.error(e);
  }
}

setInterval(() => {                           // timer event: purge expired sessions
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();

function createServer() { return http.createServer(handle); }

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`Banana Quest running at http://localhost:${PORT}`));
}

module.exports = { createServer };
