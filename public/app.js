// public/app.js - browser UI. Own code.
// EVENT-DRIVEN: no game loop. Views react to events (click, submit, keydown, load, timer tick).
// The browser holds NO game rules or solutions; it sends choices to the server and renders what comes back.
const $ = id => document.getElementById(id);

const VIEW_IDS = {
  auth: 'auth-view',
  dashboard: 'dashboard-view',
  leaderboard: 'leaderboard-view',
  profile: 'profile-view',
  battle: 'battle-view'
};
const AVATAR_FALLBACK = '🧙';

let me = null;             // profile returned by /api/me or /api/profile
let run = null;            // latest game view from the server
let answers = [];          // selected digits for the active puzzles
let timerId = null;
let busy = false;          // blocks double clicks while a request is in flight
let currentView = 'auth';
let authMode = 'login';
let messageTimer = null;
let bagOpen = false;        // equipment panel visibility during a run

// ---------- Small helpers ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
const fmt = n => Number(n || 0).toLocaleString();
const show = (id, on) => { $(id).hidden = !on; };
const activeRun = () => !!(run && run.phase !== 'over');

function dateOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function durationOf(ms) {
  if (!ms || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  return m ? `${m}m ${total % 60}s` : `${total}s`;
}

function titleFor(u) {
  if (u.wins >= 5) return 'Dungeon legend';
  if (u.wins >= 1) return 'Dragon slayer';
  if (u.bestScore >= 1000) return 'Veteran adventurer';
  if (u.runs > 0) return 'Apprentice adventurer';
  return 'Fresh recruit';
}

function setMessage(text, kind) {
  const m = $('message');
  m.textContent = text || '';
  m.className = kind || '';
  clearTimeout(messageTimer);
  if (text) messageTimer = setTimeout(() => { m.textContent = ''; m.className = ''; }, kind === 'error' ? 6000 : 4000);
}

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
  catch (e) {
    if (e.status === 401) { showAuth(); setMessage('Session expired - please log in.', 'error'); }
    else setMessage(e.message, 'error');
  }
  finally { busy = false; render(); }
}

// ---------- View routing ----------
function showView(name) {
  currentView = name;
  Object.entries(VIEW_IDS).forEach(([key, id]) => { $(id).hidden = key !== name; });
  const authed = !!me;
  $('main-nav').hidden = !authed;
  $('userbar').hidden = !authed;
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('is-active', b.dataset.nav === name));
  // Keep the puzzle timer running if the player peeks at another screen; the server
  // deadline is real, so stopping the clock here would show a misleading time.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateUserChrome() {
  if (!me) return;
  $('who').textContent = me.username;
  $('chip-avatar').textContent = me.avatar || AVATAR_FALLBACK;
  $('main-nav').hidden = false;
  $('userbar').hidden = false;
}

function showAuth() {
  stopTimer();
  me = null; run = null;
  showView('auth');
  $('password').value = ''; $('confirm').value = '';
  switchAuth('login');
}

// ---------- Auth screen ----------
function switchAuth(mode) {
  authMode = mode;
  const login = mode === 'login';
  $('tab-login').classList.toggle('is-active', login);
  $('tab-register').classList.toggle('is-active', !login);
  $('tab-login').setAttribute('aria-selected', String(login));
  $('tab-register').setAttribute('aria-selected', String(!login));
  $('confirm-wrap').hidden = login;
  $('auth-title').textContent = login ? 'Welcome back' : 'Create your adventurer';
  $('auth-sub').textContent = login ? 'Log in to continue your adventure.' : 'One account keeps your scores, history and avatar.';
  $('auth-submit').textContent = login ? 'Log in' : 'Create account';
  $('auth-hint').textContent = login ? 'No account yet? Choose Register above.' : 'Already registered? Choose Log in above.';
  $('password').setAttribute('autocomplete', login ? 'current-password' : 'new-password');
  $('auth-error').textContent = '';
}

async function authenticate() {
  const username = $('username').value.trim();
  const password = $('password').value;
  const err = $('auth-error');
  err.textContent = '';
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    err.textContent = 'Username must be 3–20 letters, digits or underscores.';
    return;
  }
  if (password.length < 6) {
    err.textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (authMode === 'register' && password !== $('confirm').value) {
    err.textContent = 'Passwords do not match.';
    return;
  }
  try {
    await api(authMode === 'register' ? '/api/register' : '/api/login', 'POST', { username, password });
    $('password').value = ''; $('confirm').value = '';
    await enterApp();
    setMessage(authMode === 'register' ? `Welcome, ${username}!` : `Welcome back, ${username}.`, 'ok');
  } catch (e) {
    err.textContent = e.message;
  }
}

// Resume an existing run or land on the dashboard.
async function enterApp() {
  me = await api('/api/me');
  updateUserChrome();
  const cur = await api('/api/run').catch(() => ({ run: null }));
  run = cur.run || null;
  if (run) {
    if (run.pending) {                 // page reloaded mid-puzzle: the images are gone, so it counts as a miss
      run = (await api('/api/run/answer', 'POST', { answers: [] })).run;
      setMessage('Puzzle abandoned - counted as a miss.', 'error');
    }
    showView('battle');
    render();
  } else {
    showView('dashboard');
    await loadDashboard();
  }
}

// ---------- Dashboard ----------
async function loadDashboard() {
  try {
    me = await api('/api/me');
    updateUserChrome();
    const cur = await api('/api/run').catch(() => ({ run: null }));
    run = cur.run || null;
    renderDashboard();
    const rows = await api('/api/leaderboard');
    renderMiniLeaderboard(rows);
  } catch (e) {
    if (e.status === 401) showAuth();
    else setMessage(e.message, 'error');
  }
}

function renderStats(container, entries) {
  container.textContent = '';
  entries.forEach(([label, value, sub]) => {
    const tile = el('div', 'stat-tile');
    tile.append(el('span', 'label', label), el('strong', '', value), el('span', 'sub', sub));
    container.appendChild(tile);
  });
}

function renderRunList(container, history, limit) {
  container.textContent = '';
  if (!history.length) {
    container.appendChild(el('li', 'empty', 'No finished runs yet. Your first adventure awaits!'));
    return;
  }
  history.slice(0, limit).forEach(h => {
    const li = el('li', 'run-item' + (h.won ? ' win' : ''));
    const main = el('div', 'run-main');
    main.append(
      el('strong', '', h.won ? '🏆 Victory' : 'Run ended'),
      el('small', '', `${dateOf(h.at)} · Floor ${h.floor || 1} · Lv ${h.level || 1}`)
    );
    li.append(el('span', 'run-icon', h.won ? '🏆' : '💀'), main, el('span', 'run-score', fmt(h.score)));
    container.appendChild(li);
  });
}

function renderMiniLeaderboard(rows) {
  const ol = $('dash-leaderboard');
  ol.textContent = '';
  if (!rows.length) { ol.appendChild(el('li', 'empty', 'No scores yet - be the first!')); return; }
  rows.slice(0, 5).forEach(r => {
    const mine = me && r.username.toLowerCase() === me.username.toLowerCase();
    const li = el('li', mine ? 'is-me' : '');
    li.append(
      el('span', 'lb-pos', r.rank),
      el('span', 'avatar', r.avatar || AVATAR_FALLBACK),
      el('span', 'lb-name', r.username),
      el('span', 'lb-score', fmt(r.bestScore))
    );
    ol.appendChild(li);
  });
}

function renderDashboard() {
  const active = activeRun();
  $('dash-greeting').textContent = `Welcome back, ${me.username}`;
  $('dash-sub').textContent = active
    ? 'You have an adventure in progress.'
    : (me.runs ? 'Your next run is waiting.' : 'Your first adventure is one click away.');
  $('dash-avatar').textContent = me.avatar || AVATAR_FALLBACK;
  $('dash-name').textContent = me.username;
  $('dash-title-text').textContent = titleFor(me);
  const rank = $('dash-rank');
  rank.hidden = !me.rank;
  rank.textContent = me.rank ? `#${me.rank} on the leaderboard` : '';
  $('continue-run-btn').hidden = !active;
  $('new-run-btn').textContent = active ? 'Start new run' : '⚔️ Start new adventure';

  renderStats($('dash-stats'), [
    ['Best score', fmt(me.bestScore), 'all time'],
    ['Wins', fmt(me.wins), `${me.winRate || 0}% win rate`],
    ['Runs', fmt(me.runs), me.runs === 1 ? 'adventure' : 'adventures'],
    ['Rooms cleared', fmt(me.bestFloor), 'best run'],
    ['Gold earned', fmt(me.totalGold), 'lifetime'],
    ['Rank', me.rank ? `#${me.rank}` : '—', me.rank ? 'global' : 'unranked']
  ]);
  renderRunList($('recent-runs'), me.history || [], 4);
}

// ---------- Leaderboard ----------
async function loadLeaderboardView() {
  try {
    const rows = await api('/api/leaderboard');
    renderLeaderboard(rows);
    $('lb-count').textContent = `${rows.length} ranked`;
  } catch (e) {
    if (e.status === 401) showAuth();
    else setMessage(e.message, 'error');
  }
}

function renderLeaderboard(rows) {
  const box = $('leaderboard-rows');
  box.textContent = '';
  if (!rows.length) {
    box.appendChild(el('p', 'empty', 'No scores yet - be the first to finish a run!'));
    return;
  }
  const medals = ['gold', 'silver', 'bronze'];
  rows.forEach(r => {
    const mine = me && r.username.toLowerCase() === me.username.toLowerCase();
    const row = el('div', 'lb-row lb-body-row' + (mine ? ' is-me' : ''));
    const user = el('div', 'lb-user');
    user.append(el('span', 'avatar avatar-xs', r.avatar || AVATAR_FALLBACK), el('strong', '', r.username));
    if (mine) user.appendChild(el('span', 'you-tag', 'YOU'));
    row.append(
      el('span', 'rank-badge' + (r.rank <= 3 ? ' ' + medals[r.rank - 1] : ''), r.rank),
      user,
      el('span', 'num', fmt(r.bestScore)),
      el('span', 'num lb-hide-sm', fmt(r.wins)),
      el('span', 'num lb-hide-sm', fmt(r.bestFloor)),
      el('span', 'num lb-hide-sm', fmt(r.runs))
    );
    box.appendChild(row);
  });
}

// ---------- Profile ----------
async function loadProfile() {
  try {
    const p = await api('/api/profile');
    me = p;
    updateUserChrome();
    renderProfile(p);
  } catch (e) {
    if (e.status === 401) showAuth();
    else setMessage(e.message, 'error');
  }
}

function renderProfile(p) {
  $('profile-avatar').textContent = p.avatar || AVATAR_FALLBACK;
  $('profile-name').textContent = p.username;
  $('profile-joined').textContent = `Joined ${dateOf(p.createdAt)}`;
  $('profile-sub').textContent = `${titleFor(p)} · ${p.runs} run${p.runs === 1 ? '' : 's'}`;
  const rank = $('profile-rank');
  rank.hidden = !p.rank;
  rank.textContent = p.rank ? `#${p.rank} globally` : '';

  renderStats($('profile-stats'), [
    ['Best score', fmt(p.bestScore), 'all time'],
    ['Wins', fmt(p.wins), `${p.winRate || 0}% win rate`],
    ['Runs', fmt(p.runs), 'finished'],
    ['Rooms cleared', fmt(p.bestFloor), 'best run'],
    ['Gold earned', fmt(p.totalGold), 'lifetime'],
    ['Enemies felled', fmt(p.totalKills), 'lifetime']
  ]);

  const picker = $('avatar-picker');
  picker.textContent = '';
  (p.avatars || []).forEach(a => {
    const b = el('button', 'avatar-choice' + (a === p.avatar ? ' is-active' : ''), a);
    b.type = 'button';
    b.title = 'Use this avatar';
    b.setAttribute('aria-label', `Use avatar ${a}`);
    b.addEventListener('click', () => chooseAvatar(a));
    picker.appendChild(b);
  });

  renderHistory($('profile-history'), p.history || []);
}

function historyStat(label, value) {
  const s = el('div', 'history-stat');
  s.append(el('span', '', label), document.createTextNode(value));
  return s;
}

function renderHistory(container, history) {
  container.textContent = '';
  if (!history.length) {
    container.appendChild(el('p', 'empty', 'No runs yet - start an adventure to build your history.'));
    return;
  }
  const head = el('div', 'history-row history-head');
  ['Run', 'Score', 'Floor', 'Gold', 'Time'].forEach((t, i) => {
    const s = el('span', i > 0 ? 'num' : '', t);
    head.appendChild(s);
  });
  container.appendChild(head);
  history.forEach(h => {
    const row = el('div', 'history-row');
    const main = el('div', 'history-main');
    main.append(el('strong', '', h.won ? '🏆 Victory' : '💀 Defeat'), el('small', '', dateOf(h.at)));
    row.append(
      main,
      historyStat('Score', fmt(h.score)),
      historyStat('Floor', h.floor || 1),
      historyStat('Gold', fmt(h.gold)),
      historyStat('Time', durationOf(h.durationMs))
    );
    container.appendChild(row);
  });
}

async function chooseAvatar(avatar) {
  if (busy || (me && me.avatar === avatar)) return;
  busy = true;
  try {
    await api('/api/profile/avatar', 'POST', { avatar });
    me.avatar = avatar;
    updateUserChrome();
    renderProfile(me);
    setMessage('Avatar updated.', 'ok');
  } catch (e) {
    setMessage(e.message, 'error');
  } finally {
    busy = false;
  }
}

// ---------- Battle rendering ----------
const pct = (v, max) => Math.max(0, Math.min(100, max ? (v / max) * 100 : 0)) + '%';

function render() {
  if (!run || currentView !== 'battle') return;
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
    const b = el('button', 'door ghost');
    b.type = 'button';
    b.disabled = busy;
    b.appendChild(el('strong', '', `${i + 1}. ${d.icon} ${d.label}`));
    if (d.enemy) b.appendChild(el('span', '', `${d.enemy.emoji} ${d.enemy.name} (${d.enemy.tierLabel})`));
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
  const bonus = h.bonus || {};
  const gear = [['atk', 'ATK'], ['def', 'DEF'], ['maxHp', 'HP'], ['maxMp', 'MP']]
    .filter(([k]) => bonus[k]).map(([k, label]) => `+${bonus[k]} ${label}`);
  $('hero-gear').textContent = gear.length ? `Gear bonus: ${gear.join(', ')}` : 'Gear bonus: none equipped';
  const ps = run.puzzleStats || { solved: 0, attempted: 0 };
  $('hero-puzzles').textContent = `🍌 Solved in time: ${ps.solved}/${ps.attempted} puzzles` +
    (ps.perfectTurns ? ` · ${ps.perfectTurns} perfect turn${ps.perfectTurns === 1 ? '' : 's'}` : '');

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

  show('enchant-card', run.phase === 'enchant');
  if (run.phase === 'enchant') renderEnchanter(run);

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
  (run.log || []).forEach(line => log.appendChild(el('li', '', line)));

  renderEquipment(run);
}

// ---------- Equipment panel ----------
const SLOT_LABELS = { weapon: 'Weapon', armor: 'Armor', trinket: 'Trinket' };

function itemStatsText(item) {
  return item.statText || Object.entries(item.stats || {}).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ');
}

function renderEquipment(run) {
  const equipment = run.equipment || {};
  const inventory = run.inventory || [];
  const total = inventory.length + Object.values(equipment).filter(Boolean).length;
  const btn = $('bag-btn');
  btn.textContent = total ? `🎒 Bag · ${total}` : '🎒 Bag';
  btn.setAttribute('aria-expanded', String(bagOpen));
  btn.classList.toggle('is-active', bagOpen);
  show('equip-card', bagOpen);
  if (!bagOpen) return;

  const locked = busy || !!run.pending || run.phase === 'over';

  const slots = $('equip-slots');
  slots.textContent = '';
  Object.entries(SLOT_LABELS).forEach(([slot, label]) => {
    const item = equipment[slot];
    const card = el(item ? 'button' : 'div', 'equip-slot' + (item ? ` rarity-${item.rarity}` : ' is-empty'));
    if (item) {
      card.type = 'button';
      card.title = `Unequip ${item.name}`;
      card.disabled = locked;
      card.append(
        el('span', 'slot-tag', label),
        el('span', 'item-line', `${item.icon} ${item.name}`),
        el('span', 'item-stats', itemStatsText(item)),
        ...(item.enchant ? [el('span', 'enchant-line', enchantTag(item))] : []),
        el('span', 'rarity-tag', item.rarityLabel)
      );
      card.addEventListener('click', () => changeEquipment('unequip', { slot }));
    } else {
      card.append(el('span', 'slot-tag', label), el('span', 'slot-empty', 'Empty'));
    }
    slots.appendChild(card);
  });

  const bag = $('bag-list');
  bag.textContent = '';
  if (!inventory.length) {
    bag.appendChild(el('li', 'empty', 'Your bag is empty. Defeat enemies to find loot.'));
    return;
  }
  inventory.forEach(item => {
    const li = el('li', 'bag-item rarity-' + item.rarity);
    const main = el('div', 'bag-main');
    main.append(
      el('span', 'item-line', `${item.icon} ${item.name}`),
      el('span', 'item-stats', itemStatsText(item)),
      ...(item.enchant ? [el('span', 'enchant-line', enchantTag(item))] : [])
    );
    const action = el('button', 'small equip-btn', `Equip · ${SLOT_LABELS[item.slot]}`);
    action.type = 'button';
    action.disabled = locked;
    action.addEventListener('click', () => changeEquipment('equip', { itemId: item.id }));
    li.append(el('span', 'rarity-tag', item.rarityLabel), main, action);
    bag.appendChild(li);
  });
}

function changeEquipment(kind, payload) {
  guarded(async () => {
    setMessage('');
    run = (await api('/api/run/' + kind, 'POST', payload)).run;
  });
}

// ---------- Enchanter panel ----------
function enchantTag(item) {
  const e = item && item.enchant;
  return e ? `${e.icon} ${e.tierName} ${e.name} (${e.text})` : '';
}

function renderEnchanter(run) {
  const info = run.enchanting;
  if (!info) return;
  const tier = info.tier;
  const ps = run.puzzleStats || { solved: 0 };
  const pill = $('enchant-tier');
  pill.textContent = tier ? `${tier.name} tier` : 'Locked';
  pill.className = 'pill' + (tier ? ' is-on' : '');

  const hint = $('enchant-hint');
  if (!tier) {
    hint.textContent = `Solve ${info.next.solved} puzzles in time to unlock enchanting. You have solved ${ps.solved}.`;
  } else {
    hint.textContent = `Each enchantment costs ${tier.gold} gold. ` + (info.next
      ? `Solve ${info.next.solved} puzzles in time to reach ${info.next.name} tier (you have ${ps.solved}).`
      : `You have reached the highest tier (${ps.solved} solved).`);
  }

  const list = $('enchant-list');
  list.textContent = '';
  if (!info.items.length) {
    list.appendChild(el('p', 'empty', 'You have no gear to enchant. Find some loot first.'));
    return;
  }
  info.items.forEach(item => {
    const row = el('div', 'enchant-item rarity-' + String(item.rarity || '').toLowerCase());
    const head = el('div', 'enchant-head');
    head.append(el('span', 'item-line', `${item.icon} ${item.name}`));
    if (item.equipped) head.appendChild(el('span', 'equip-badge', 'Equipped'));
    head.appendChild(el('span', 'rarity-tag', item.rarity || ''));
    row.appendChild(head);
    row.appendChild(el('span', 'item-stats', enchantTag(item) || 'No enchantment yet'));

    const controls = el('div', 'enchant-controls');
    const select = el('select', 'enchant-select');
    select.setAttribute('aria-label', `Enchantment for ${item.name}`);
    select.disabled = busy || !tier;
    info.options.forEach(o => {
      const opt = el('option', '', `${o.icon} ${o.name} · +${o.amount} ${o.statLabel} · ${o.cost} 🪙`);
      opt.value = o.key;
      select.appendChild(opt);
    });
    const btn = el('button', 'small', tier ? `Enchant · ${tier.gold} 🪙` : 'Locked');
    btn.type = 'button';
    btn.disabled = busy || !tier || run.hero.gold < tier.gold;
    btn.addEventListener('click', () => enchantGear(item.id, select.value));
    controls.append(select, btn);
    row.appendChild(controls);
    list.appendChild(row);
  });
}

function enchantGear(itemId, enchantKey) {
  if (!enchantKey) return;
  guarded(async () => {
    setMessage('');
    run = (await api('/api/run/enchant', 'POST', { itemId, enchantKey })).run;
    setMessage('Enchantment applied.', 'ok');
  });
}

// ---------- Puzzle panel ----------
function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

function openPuzzles(puzzles, seconds, label) {
  answers = new Array(puzzles.length).fill(null);
  $('puzzle-title').textContent = `${label}: solve ${puzzles.length} puzzle${puzzles.length > 1 ? 's' : ''}`;
  const box = $('puzzles'); box.innerHTML = '';
  puzzles.forEach((p, i) => {
    const wrap = el('div', 'puzzle');
    const img = el('img');
    img.src = p.image; img.alt = `Banana puzzle ${i + 1}`;
    const digits = el('div', 'digits');
    for (let d = 0; d <= 9; d++) {
      const b = el('button', '', d);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
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
    if (run.phase === 'over') await refreshProfile();
  });
}

async function refreshProfile() {
  try { me = await api('/api/me'); updateUserChrome(); } catch (e) { /* optional */ }
}

// ---------- Flow ----------
function startRun() {
  if (activeRun() && !confirm('Abandon your current run and start a new one?')) return;
  guarded(async () => {
    run = (await api('/api/run/new', 'POST')).run;
    setMessage('');
    showView('battle');
    render();
  });
}

function chooseDoor(choice) {
  guarded(async () => { setMessage(''); run = (await api('/api/run/door', 'POST', { choice })).run; });
}

function leaveRoom() {
  guarded(async () => { setMessage(''); run = (await api('/api/run/leave', 'POST', {})).run; });
}

function goHome() {
  showView('dashboard');
  loadDashboard();
}

// ---------- Event wiring ----------
$('auth-form').addEventListener('submit', e => { e.preventDefault(); authenticate(); });
$('tab-login').addEventListener('click', () => switchAuth('login'));
$('tab-register').addEventListener('click', () => switchAuth('register'));

$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST'); } catch (e) { /* already out */ }
  setMessage('Logged out.', 'ok');
  showAuth();
});

$('brand-home').addEventListener('click', () => {
  if (!me) { showView('auth'); return; }
  goHome();
});

document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
  const target = b.dataset.nav;
  if (target === 'dashboard') goHome();
  else if (target === 'leaderboard') { showView('leaderboard'); loadLeaderboardView(); }
  else if (target === 'profile') { showView('profile'); loadProfile(); }
}));

$('new-run-btn').addEventListener('click', startRun);
$('continue-run-btn').addEventListener('click', () => { showView('battle'); render(); });
$('again-btn').addEventListener('click', startRun);
$('battle-home-btn').addEventListener('click', goHome);
$('over-home-btn').addEventListener('click', goHome);
$('bag-btn').addEventListener('click', () => { bagOpen = !bagOpen; render(); });
$('submit-btn').addEventListener('click', submitAnswers);

document.querySelectorAll('#actions button').forEach(b => b.addEventListener('click', () => {
  const action = b.dataset.action;
  guarded(async () => {
    setMessage('');
    const data = await api('/api/run/action', 'POST', { action });
    run = data.run;
    if (data.puzzles.length) openPuzzles(data.puzzles, data.seconds, run.actions[action].label);
    else if (run.phase === 'over') await refreshProfile();
  });
}));

$('buy-btn').addEventListener('click', () => guarded(async () => { run = (await api('/api/run/shop', 'POST', {})).run; }));
$('leave-btn').addEventListener('click', leaveRoom);       // leave the merchant
$('enchant-leave-btn').addEventListener('click', leaveRoom); // leave the enchanter
$('continue-btn').addEventListener('click', leaveRoom);    // leave a cleared room / treasure / campfire

// Keyboard events: digits fill the next empty puzzle slot; Enter submits; A/S/H/D/P pick actions.
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (currentView !== 'battle' || !run) return;
  if (!$('puzzle-card').hidden) {
    if (/^[0-9]$/.test(e.key)) { const i = answers.findIndex(a => a === null); pick(i === -1 ? answers.length - 1 : i, Number(e.key)); }
    else if (e.key === 'Enter') submitAnswers();
    return;
  }
  if (run.phase === 'map' && /^[1-2]$/.test(e.key)) return chooseDoor(Number(e.key) - 1);     // 1/2 = doors
  if ((run.phase === 'event' || run.phase === 'shop' || run.phase === 'enchant') && e.key === 'Enter') return leaveRoom();
  if (e.key.toLowerCase() === 'b') { bagOpen = !bagOpen; render(); return; }                 // B = bag
  const map = { a: 'attack', s: 'skill', h: 'heal', d: 'defend', p: 'potion' };
  const btn = map[e.key.toLowerCase()] && document.querySelector(`#actions button[data-action="${map[e.key.toLowerCase()]}"]`);
  if (btn && !btn.disabled && !$('actions').hidden) btn.click();
});

// Page load event: if the session cookie is still valid, resume the game.
window.addEventListener('load', async () => {
  switchAuth('login');
  try {
    const session = await api('/api/session');
    if (!session.username) return showAuth();
    await enterApp();
  } catch (e) { showAuth(); }
});
