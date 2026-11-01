// test.js - tests using Node's built-in runner (no packages). Own code.
// Run: npm test   (or: node --test)
// A fake Banana API runs locally so tests are fast, deterministic and work offline.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-quest-'));
process.env.DATA_DIR = DATA_DIR;

let fakeSolution = 7, fakeDown = false;
const fake = http.createServer((req, res) => {
  if (fakeDown) { res.writeHead(500); return res.end('down'); }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ question: 'https://example.test/p.png', solution: fakeSolution }));
});

const game = require('./game');
const { createServer } = require('./server');
const SOURCE = async n => Array.from({ length: n }, () => ({ image: 'https://example.test/p.png', solution: 7 }));
const rng = () => 0.5;                         // variance factor exactly 1.0 -> deterministic damage

// ---------- Engine unit tests ----------
test('mob attack costs 1 puzzle, boss attack costs 3, skill adds one', () => {
  const run = game.createRun('u', rng);
  const v = game.view(run);
  assert.strictEqual(v.actions.attack.puzzles, 1);
  assert.strictEqual(v.actions.skill.puzzles, 2);
  run.floor = game.ENCOUNTERS.length - 1;
  run.enemy.tier = 'boss';
  const b = game.view(run);
  assert.strictEqual(b.actions.attack.puzzles, 3);
  assert.strictEqual(b.actions.skill.puzzles, 4);
  assert.strictEqual(b.actions.heal.puzzles, 1);
});

test('correct answer damages enemy; solutions never appear in the view', async () => {
  const run = game.createRun('u', rng);
  const start = await game.startAction(run, 'attack', SOURCE);
  assert.strictEqual(start.puzzles.length, 1);
  assert.ok(!JSON.stringify(start).includes('solution'));
  assert.ok(!JSON.stringify(game.view(run)).includes('solution'));
  const before = run.enemy.hp;
  game.answer(run, [7]);
  assert.strictEqual(before - run.enemy.hp, 12 - 0);   // hero atk 12, slime def 0
  assert.ok(run.hero.hp < 60);                          // enemy hit back
});

test('wrong answer misses, resets combo; non-integer answers are wrong', async () => {
  const run = game.createRun('u', rng);
  run.combo = 3;
  await game.startAction(run, 'attack', SOURCE);
  const before = run.enemy.hp;
  game.answer(run, ['7']);                              // string is not accepted
  assert.strictEqual(run.enemy.hp, before);
  assert.strictEqual(run.combo, 0);
});

test('answering after the deadline counts as a timeout', async () => {
  const run = game.createRun('u', rng);
  await game.startAction(run, 'attack', SOURCE, 1000);
  const r = game.answer(run, [7], 1000 + 20000 + game.GRACE_MS + 1);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.correct, 0);
});

test('skill costs MP only after puzzles are fetched; source failure uses no turn', async () => {
  const run = game.createRun('u', rng);
  await assert.rejects(game.startAction(run, 'skill', async () => { throw new Error('down'); }));
  assert.strictEqual(run.hero.mp, 20);
  assert.strictEqual(run.pending, null);
  assert.strictEqual(run.busy, false);
  await game.startAction(run, 'skill', SOURCE);
  assert.strictEqual(run.hero.mp, 12);
});

test('cannot start a second action while a puzzle is pending', async () => {
  const run = game.createRun('u', rng);
  await game.startAction(run, 'attack', SOURCE);
  await assert.rejects(game.startAction(run, 'attack', SOURCE), /Finish the current puzzle/);
});

test('defend halves the next hit and restores MP; potion heals', async () => {
  const run = game.createRun('u', rng);
  run.hero.mp = 5;
  await game.startAction(run, 'defend', SOURCE);
  assert.strictEqual(run.hero.mp, 9);
  assert.strictEqual(run.hero.hp, 60 - Math.ceil((6 - 2) / 2));   // slime atk 6, hero def 2
  run.hero.hp = 10;
  await game.startAction(run, 'potion', SOURCE);
  assert.ok(run.hero.hp > 40);
  assert.strictEqual(run.hero.potions, 0);
  await assert.rejects(game.startAction(run, 'potion', SOURCE), /No potions/);
});

test('bosses telegraph and unleash a heavy attack every third turn', async () => {
  const run = game.createRun('u', rng);
  run.floor = 3; run.enemy = { ...game.ENCOUNTERS[3], maxHp: 999, hp: 999, turn: 1, nextMove: 'normal' };
  run.hero.maxHp = run.hero.hp = 500;
  await game.startAction(run, 'defend', SOURCE);          // enemy turn 2
  assert.strictEqual(run.enemy.nextMove, 'heavy');
  const hp = run.hero.hp;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7, 7]);                               // enemy turn 3 = heavy
  assert.ok(hp - run.hero.hp >= (12 - 2) * 2 - 1);
});

test('killing an enemy grants xp/gold, level up restores stats, opens the shop', async () => {
  const run = game.createRun('u', rng);
  run.enemy.hp = 1;
  run.hero.xp = 20;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7]);
  assert.strictEqual(run.phase, 'shop');
  assert.strictEqual(run.hero.level, 2);
  assert.strictEqual(run.hero.hp, run.hero.maxHp);
  assert.strictEqual(run.hero.gold, 10);
  assert.throws(() => game.buyPotion(run), /Not enough gold/);   // potion costs 15
  run.hero.gold = 20;
  game.buyPotion(run);
  assert.strictEqual(run.hero.potions, 2);
  game.nextFloor(run);
  assert.strictEqual(run.enemy.name, 'Goblin');
  assert.throws(() => game.buyPotion(run), /only open between fights/);
});

test('dying ends the run and fires runOver exactly once', async () => {
  const run = game.createRun('u', rng);
  let fired = 0;
  run.events.on('runOver', () => fired++);
  run.hero.hp = 1;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [0]);
  assert.strictEqual(run.phase, 'over');
  assert.strictEqual(fired, 1);
  await assert.rejects(game.startAction(run, 'attack', SOURCE), /not in combat/);
});

test('a perfect player can win the whole dungeon', async () => {
  const run = game.createRun('u', rng);
  let guard = 0;
  while (run.phase !== 'over' && guard++ < 400) {
    if (run.phase === 'shop') { while (run.hero.gold >= 15 && run.hero.potions < 3) game.buyPotion(run); game.nextFloor(run); continue; }
    const h = run.hero, e = run.enemy;
    const a = e.nextMove === 'heavy' && h.hp < h.maxHp * 0.6 ? 'defend'
      : h.hp < h.maxHp * 0.35 && h.potions > 0 ? 'potion'
      : h.hp < h.maxHp * 0.4 && h.mp >= 6 ? 'heal'
      : h.mp >= 8 ? 'skill' : 'attack';
    const s = await game.startAction(run, a, SOURCE);
    if (s.puzzles.length) game.answer(run, s.puzzles.map(() => 7));
  }
  assert.strictEqual(run.won, true);
  assert.strictEqual(run.cleared, game.ENCOUNTERS.length);
});

// ---------- HTTP integration tests ----------
let base, server, cookie = '';

async function call(p, method = 'GET', body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.get('set-cookie');
  if (sc && /^sid=[^;]+/.test(sc)) cookie = sc.split(';')[0];
  return { status: res.status, set: sc, headers: res.headers, body: await res.json().catch(() => ({})) };
}

test.before(async () => {
  await new Promise(r => fake.listen(0, r));
  process.env.BANANA_API = `http://127.0.0.1:${fake.address().port}/api.php`;
  server = createServer();
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close(); fake.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('http: protected routes reject anonymous users; static page is served with CSP', async () => {
  assert.strictEqual((await call('/api/run')).status, 401);
  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual((await fetch(base + '/..%2Fserver.js')).status === 200, false);   // no path traversal
});

test('http: register validates input, sets HttpOnly SameSite cookie, rejects duplicates', async () => {
  assert.strictEqual((await call('/api/register', 'POST', { username: 'a', password: '123' })).status, 400);
  const r = await call('/api/register', 'POST', { username: 'hero1', password: 'secret1' });
  assert.strictEqual(r.status, 200);
  assert.match(r.set, /HttpOnly/);
  assert.match(r.set, /SameSite=Strict/);
  const saved = cookie; cookie = '';
  assert.strictEqual((await call('/api/register', 'POST', { username: 'HERO1', password: 'secret1' })).status, 409);
  cookie = saved;
});

test('http: passwords are hashed on disk; login lockout after repeated failures', async () => {
  const stored = fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8');
  assert.ok(!stored.includes('secret1'));
  cookie = '';
  for (let i = 0; i < 5; i++) assert.strictEqual((await call('/api/login', 'POST', { username: 'hero1', password: 'wrong111' })).status, 401);
  assert.strictEqual((await call('/api/login', 'POST', { username: 'hero1', password: 'secret1' })).status, 429);
  // fresh account for the remaining tests
  assert.strictEqual((await call('/api/register', 'POST', { username: 'hero2', password: 'secret2' })).status, 200);
});

test('http: full turn through the API with the fake Banana service', async () => {
  assert.strictEqual((await call('/api/run')).body.run, null);
  assert.strictEqual((await call('/api/run/action', 'POST', { action: 'attack' })).status, 404);   // no run yet
  assert.strictEqual((await call('/api/run/new', 'POST')).status, 200);
  const a = await call('/api/run/action', 'POST', { action: 'attack' });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.puzzles.length, 1);
  assert.ok(!JSON.stringify(a.body).includes('solution'));
  assert.strictEqual(a.body.run.pending.n, 1);
  const r = await call('/api/run/answer', 'POST', { answers: [7] });
  assert.strictEqual(r.body.result.correct, 1);
  assert.ok(r.body.run.enemy.hp < r.body.run.enemy.maxHp);
  assert.strictEqual((await call('/api/run/answer', 'POST', { answers: [7] })).status, 400);        // nothing pending
  assert.strictEqual((await call('/api/run/action', 'POST', { action: 'nuke' })).status, 400);
});

test('http: Banana outage returns 502 and does not cost a turn or MP', async () => {
  fakeDown = true;
  const r = await call('/api/run/action', 'POST', { action: 'skill' });
  fakeDown = false;
  assert.strictEqual(r.status, 502);
  const v = (await call('/api/run')).body.run;
  assert.strictEqual(v.hero.mp, 20);
  assert.strictEqual(v.pending, null);
});

test('http: finished run is saved to the leaderboard once; logout kills the session', async () => {
  const run0 = (await call('/api/run/new', 'POST')).body.run;
  assert.ok(run0.hero.hp > 0);
  for (let i = 0; i < 60; i++) {                         // answer wrong on purpose until the hero dies
    const a = await call('/api/run/action', 'POST', { action: 'attack' });
    if (a.status !== 200) break;
    const r = await call('/api/run/answer', 'POST', { answers: [0] });
    if (r.body.run.phase === 'over') break;
  }
  const lb = (await call('/api/leaderboard')).body;
  assert.ok(lb.some(r => r.username === 'hero2'));
  const me = (await call('/api/me')).body;
  assert.strictEqual(me.runs, 1);
  await call('/api/logout', 'POST');
  assert.strictEqual((await call('/api/me')).status, 401);
});
