// public/app.js - browser UI. Own code.
// EVENT-DRIVEN: no game loop. The page only reacts to events (click, submit, keydown, load, timer tick).
// The browser holds NO game rules or solutions; it sends choices to the server and renders what comes back.
const $ = id => document.getElementById(id);
let run = null;            // latest game view from the server
let answers = [];          // selected digits for the active puzzles
let timerId = null;
let busy = false;          // blocks double clicks while a request is in flight

function setMessage(text, kind) { const m = $('message'); m.textContent = text || ''; m.className = kind || ''; }

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

// Wrap server calls: disable input while waiting, show errors, handle expired sessions.
async function guarded(fn) {
  if (busy) return;
  busy = true; render();
  try { await fn(); }
  catch (e) { if (e.status === 401) { showAuth(); setMessage('Session expired - please log in.', 'error'); } else setMessage(e.message, 'error'); }
  finally { busy = false; render(); }
}

// ---------- Rendering ----------
const pct = (v, max) => Math.max(0, Math.min(100, max ? (v / max) * 100 : 0)) + '%';

function show(id, on) { $(id).hidden = !on; }

function showAuth() {
  stopTimer(); run = null;
  show('auth-view', true); show('menu-view', false); show('battle-view', false); show('userbar', false);
  $('password').value = '';
}

function render() {
  const inRun = !!run;
  show('battle-view', inRun);
  if (!inRun) return;
  const h = run.hero, e = run.enemy, pending = !!run.pending || !$('puzzle-card').hidden;

  // Dungeon progress: floor name + a dot per room (filled = done, ring = current)
  $('floor').textContent = `${run.map.floorName} (floor ${run.floor}/${run.totalFloors})`;
  $('room-step').textContent = `Room ${run.map.step} / ${run.map.totalSteps}`;
  const prog = $('progress'); prog.textContent = '';
  for (let i = 1; i <= run.map.totalSteps; i++) {
    prog.textContent += i < run.map.step ? '● ' : i === run.map.step ? '◉ ' : '○ ';
  }

  // Door choice between rooms
  show('map-card', run.phase === 'map');
  const doors = $('doors'); doors.textContent = '';
  (run.map.doors || []).forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'door ghost'; b.disabled = busy;
    const title = document.createElement('strong');
    title.textContent = `${i + 1}. ${d.icon} ${d.label}`;
    b.appendChild(title);
    if (d.enemy) {
      const sub = document.createElement('span');
      sub.textContent = `${d.enemy.emoji} ${d.enemy.name} (${d.enemy.tierLabel})`;
      b.appendChild(sub);
    }
    b.addEventListener('click', () => chooseDoor(i));          // EVENT: click on a door
    doors.appendChild(b);
  });

  show('enemy-card', !!e);
  if (e) {
    $('tier').textContent = e.tierLabel; $('tier').className = 'badge ' + e.tier;
    $('enemy-emoji').textContent = e.hp > 0 ? e.emoji : '💨';
    $('enemy-name').textContent = e.name;
    $('enemy-hp').style.width = pct(e.hp, e.maxHp);
    $('enemy-hp-text').textContent = `${e.hp} / ${e.maxHp} HP`;
  }
  show('warning', !!e && run.phase === 'combat' && e.nextMove === 'heavy');

  $('hero-level').textContent = `Hero Lv ${h.level}  (ATK ${h.atk}, DEF ${h.def})`;
  $('hero-gold').textContent = `🪙 ${h.gold}   🧪 ${h.potions}`;
  $('hero-hp').style.width = pct(h.hp, h.maxHp); $('hero-hp-text').textContent = `${h.hp}/${h.maxHp}`;
  $('hero-mp').style.width = pct(h.mp, h.maxMp); $('hero-mp-text').textContent = `${h.mp}/${h.maxMp}`;
  $('hero-xp').style.width = pct(h.xp, h.xpToNext); $('hero-xp-text').textContent = `${h.xp}/${h.xpToNext}`;
  $('hero-extra').textContent = `Combo x${run.combo} (+${Math.min(run.combo, 5) * 10}% damage)` + (h.defending ? ' · Defending' : '');

  const combat = run.phase === 'combat';
  show('actions', combat);
  document.querySelectorAll('#actions button').forEach(b => {
    const a = run.actions[b.dataset.action];
    const parts = [a.label];
    if (a.mp) parts.push(`${a.mp} MP`);
    parts.push(a.puzzles ? `${a.puzzles} puzzle${a.puzzles > 1 ? 's' : ''}` : 'no puzzle');
    b.textContent = parts.join(' · ');
    b.disabled = busy || pending || h.mp < a.mp || (b.dataset.action === 'potion' && h.potions < 1);
  });

  show('shop-card', run.phase === 'shop');
  $('buy-btn').textContent = `Buy potion (${run.potionPrice} 🪙)`;
  $('buy-btn').disabled = busy || h.gold < run.potionPrice;
  $('leave-btn').disabled = busy;

  show('event-card', run.phase === 'event');
  if (run.phase === 'event') {
    $('event-title').textContent = run.room && run.room.type === 'treasure' ? '💰 Treasure!'
      : run.room && run.room.type === 'rest' ? '🔥 Campfire' : '✅ Room cleared';
  }
  $('continue-btn').disabled = busy;

  show('over-card', run.phase === 'over');
  if (run.phase === 'over') {
    $('over-title').textContent = run.won ? '🏆 You conquered the dungeon!' : '💀 Game over';
    $('over-score').textContent = `Score: ${run.score}`;
  }

  const log = $('log'); log.innerHTML = '';
  (run.log || []).forEach(line => { const li = document.createElement('li'); li.textContent = line; log.appendChild(li); });
}

async function loadLeaderboard() {
  try {
    const rows = await api('/api/leaderboard');
    const ol = $('leaderboard'); ol.innerHTML = '';
    rows.forEach(r => { const li = document.createElement('li'); li.textContent = `${r.username}: ${r.bestScore} (${r.wins} wins)`; ol.appendChild(li); });
    if (!rows.length) { const li = document.createElement('li'); li.textContent = 'No scores yet - be the first!'; ol.appendChild(li); }
  } catch (e) { /* optional */ }
}

// ---------- Puzzle panel ----------
function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

function openPuzzles(puzzles, seconds, label) {
  answers = new Array(puzzles.length).fill(null);
  $('puzzle-title').textContent = `${label}: solve ${puzzles.length} puzzle${puzzles.length > 1 ? 's' : ''}`;
  const box = $('puzzles'); box.innerHTML = '';
  puzzles.forEach((p, i) => {
    const wrap = document.createElement('div'); wrap.className = 'puzzle';
    const img = document.createElement('img'); img.src = p.image; img.alt = `Banana puzzle ${i + 1}`;
    const digits = document.createElement('div'); digits.className = 'digits';
    for (let d = 0; d <= 9; d++) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = d; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => pick(i, d));       // EVENT: click on a digit
      digits.appendChild(b);
    }
    wrap.append(img, digits); box.appendChild(wrap);
  });
  show('puzzle-card', true);
  const end = Date.now() + seconds * 1000;
  stopTimer();
  const tick = () => {                                      // EVENT: timer tick every 250 ms
    const left = Math.max(0, end - Date.now());
    $('timer').textContent = `⏱ ${Math.ceil(left / 1000)}s`;
    $('timer').className = left < 5000 ? 'low' : '';
    if (left <= 0) { stopTimer(); submitAnswers(); }       // EVENT: time is up -> auto-submit
  };
  tick(); timerId = setInterval(tick, 250);
}

function pick(i, d) {
  answers[i] = d;
  document.querySelectorAll('#puzzles .puzzle')[i].querySelectorAll('.digits button')
    .forEach((b, idx) => b.setAttribute('aria-pressed', idx === d ? 'true' : 'false'));
}

function submitAnswers() {
  if ($('puzzle-card').hidden) return;
  stopTimer();
  show('puzzle-card', false);
  guarded(async () => {
    const data = await api('/api/run/answer', 'POST', { answers });
    run = data.run;
    const r = data.result;
    setMessage(r.timedOut ? 'Too slow!' : `${r.correct}/${r.total} correct`, r.correct === r.total ? 'ok' : 'error');
    if (run.phase === 'over') loadMenuStats();
    loadLeaderboard();
  });
}

// ---------- Flow ----------
async function loadMenuStats() {
  try { const me = await api('/api/me'); $('record').textContent = `Best score ${me.bestScore} · Best floors cleared ${me.bestFloor} · Wins ${me.wins} · Runs ${me.runs}`; } catch (e) { /* ignore */ }
}

async function enterGame(username) {
  $('who').textContent = username; show('userbar', true); show('auth-view', false);
  await loadMenuStats();
  const cur = await api('/api/run');
  run = cur.run;
  if (run && run.pending) {                   // page was reloaded mid-puzzle: the images are gone, so it counts as a miss
    run = (await api('/api/run/answer', 'POST', { answers: [] })).run;
    setMessage('Puzzle abandoned - counted as a miss.', 'error');
  }
  show('menu-view', !run);
  render();
}

async function authenticate(path) {
  try {
    const u = await api(path, 'POST', { username: $('username').value.trim(), password: $('password').value });
    setMessage(''); await enterGame(u.username);
  } catch (e) { setMessage(e.message, 'error'); }
}

function startRun() { guarded(async () => { run = (await api('/api/run/new', 'POST')).run; show('menu-view', false); setMessage(''); }); }

// ---------- Event wiring ----------
$('auth-form').addEventListener('submit', e => { e.preventDefault(); authenticate('/api/login'); });
$('register-btn').addEventListener('click', () => authenticate('/api/register'));
$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST'); } catch (e) { /* already out */ }
  setMessage('Logged out.'); showAuth();
});
$('new-run-btn').addEventListener('click', startRun);
$('again-btn').addEventListener('click', startRun);
$('submit-btn').addEventListener('click', submitAnswers);

document.querySelectorAll('#actions button').forEach(b => b.addEventListener('click', () => {
  const action = b.dataset.action;
  guarded(async () => {
    setMessage('');
    const data = await api('/api/run/action', 'POST', { action });
    run = data.run;
    if (data.puzzles.length) openPuzzles(data.puzzles, data.seconds, run.actions[action].label);
    else { loadLeaderboard(); if (run.phase === 'over') loadMenuStats(); }
  });
}));

$('buy-btn').addEventListener('click', () => guarded(async () => { run = (await api('/api/run/shop', 'POST', {})).run; }));
function chooseDoor(choice) {
  guarded(async () => { setMessage(''); run = (await api('/api/run/door', 'POST', { choice })).run; });
}
function leaveRoom() {
  guarded(async () => { setMessage(''); run = (await api('/api/run/leave', 'POST', {})).run; });
}
$('leave-btn').addEventListener('click', leaveRoom);       // leave the merchant
$('continue-btn').addEventListener('click', leaveRoom);    // leave a cleared room / treasure / campfire

// Keyboard events: digits fill the next empty puzzle slot; Enter submits; A/S/H/D/P pick actions.
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('puzzle-card').hidden) {
    if (/^[0-9]$/.test(e.key)) { const i = answers.findIndex(a => a === null); pick(i === -1 ? answers.length - 1 : i, Number(e.key)); }
    else if (e.key === 'Enter') submitAnswers();
    return;
  }
  if (run && run.phase === 'map' && /^[1-2]$/.test(e.key)) return chooseDoor(Number(e.key) - 1);     // 1/2 = doors
  if (run && (run.phase === 'event' || run.phase === 'shop') && e.key === 'Enter') return leaveRoom();
  const map = { a: 'attack', s: 'skill', h: 'heal', d: 'defend', p: 'potion' };
  const btn = map[e.key.toLowerCase()] && document.querySelector(`#actions button[data-action="${map[e.key.toLowerCase()]}"]`);
  if (btn && !btn.disabled && !$('actions').hidden) btn.click();
});

// Page load event: if the session cookie is still valid, resume the game.
window.addEventListener('load', async () => {
  loadLeaderboard();
  try { const me = await api('/api/me'); await enterGame(me.username); } catch (e) { showAuth(); }
});
