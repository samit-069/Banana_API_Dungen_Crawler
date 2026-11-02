// game.js - RPG engine. Own code. No I/O: puzzles come in through an injected `source`
// function, randomness through an injected `rng`, so the rules are fully unit-testable.
//
// EVENT-DRIVEN design: the engine never writes log text directly. It emits events
// ('heroHit', 'enemyHit', 'levelUp', 'roomEntered', ...) on a per-run EventEmitter and listeners react
// (here: build the combat log; the server also listens for 'runOver' to save the score).
//
// DUNGEON STRUCTURE:  Dungeon -> Floors -> Rooms.
//   Each floor is a few "steps". At every step the player chooses between two doors
//   (a fight is always on offer; the other door is a fight, treasure, campfire or merchant).
//   The last step of each floor is its boss room. Beating the last floor's boss wins the run.
//
// Run phases:  map (choose a door) -> combat | event (treasure, rest, room cleared) | shop -> map ... -> over
'use strict';
const { EventEmitter } = require('events');

const GRACE_MS = 3000;       // allowance for network + image loading after the timer starts
const POTION_PRICE = 15;

// Banana puzzles have a fixed difficulty, so enemy tiers scale by puzzle COUNT and TIME.
const TIERS = {
  mob:     { label: 'Mob',      puzzles: 1, secondsPerPuzzle: 20 },
  midboss: { label: 'Mid-boss', puzzles: 2, secondsPerPuzzle: 15 },
  boss:    { label: 'Boss',     puzzles: 3, secondsPerPuzzle: 12 }
};

// ---------- Content (pure data: add monsters / floors here without touching the rules) ----------
const BESTIARY = {
  Slime:             { emoji: '🟢', tier: 'mob',     hp: 30,  atk: 6,  def: 0, xp: 14,  gold: 10 },
  Rat:               { emoji: '🐀', tier: 'mob',     hp: 26,  atk: 7,  def: 0, xp: 12,  gold: 8 },
  Goblin:            { emoji: '👺', tier: 'mob',     hp: 40,  atk: 8,  def: 1, xp: 18,  gold: 12 },
  Skeleton:          { emoji: '🦴', tier: 'mob',     hp: 50,  atk: 10, def: 2, xp: 24,  gold: 15 },
  Orc:               { emoji: '👹', tier: 'mob',     hp: 55,  atk: 11, def: 2, xp: 28,  gold: 18 },
  Wraith:            { emoji: '👻', tier: 'mob',     hp: 60,  atk: 12, def: 3, xp: 34,  gold: 24 },
  Gargoyle:          { emoji: '🗿', tier: 'mob',     hp: 70,  atk: 13, def: 4, xp: 40,  gold: 28 },
  'Skeleton Knight': { emoji: '💀', tier: 'midboss', hp: 75,  atk: 12, def: 3, xp: 55,  gold: 40 },
  'Orc Warlord':     { emoji: '🪓', tier: 'midboss', hp: 95,  atk: 15, def: 4, xp: 80,  gold: 60 },
  'Ancient Dragon':  { emoji: '🐉', tier: 'boss',    hp: 130, atk: 17, def: 4, xp: 150, gold: 100 }
};

const DUNGEON = {
  name: 'The Banana Crypt',
  floors: [
    { name: 'Mossy Cellar',  steps: 3, pool: ['Slime', 'Rat', 'Goblin'],        end: 'Skeleton Knight' },
    { name: 'Bone Halls',    steps: 3, pool: ['Skeleton', 'Orc', 'Goblin'],     end: 'Orc Warlord' },
    { name: "Dragon's Lair", steps: 3, pool: ['Wraith', 'Gargoyle', 'Orc'],     end: 'Ancient Dragon' }
  ]
};

// Chance table for the optional second door (the first door is always a fight).
const OTHER_DOOR_ODDS = [['combat', 0.40], ['treasure', 0.20], ['rest', 0.25], ['shop', 0.15]];

const ROOM_INFO = {
  combat:   { icon: '⚔️', label: 'Monster' },
  boss:     { icon: '☠️', label: 'Floor boss' },
  treasure: { icon: '💰', label: 'Treasure' },
  rest:     { icon: '🔥', label: 'Campfire' },
  shop:     { icon: '🛒', label: 'Merchant' }
};

const ACTIONS = {
  attack: { label: 'Attack',      mp: 0, power: 1.0 },
  skill:  { label: 'Power Strike', mp: 8, power: 2.2 },
  heal:   { label: 'Heal',        mp: 6 },
  defend: { label: 'Defend',      mp: 0 },
  potion: { label: 'Potion',      mp: 0 }
};

function gameError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const xpToNext = level => 25 * level;
const pick = (run, arr) => arr[Math.min(arr.length - 1, Math.floor(run.rng() * arr.length))];

function puzzleCount(action, tier) {
  const base = TIERS[tier].puzzles;
  if (action === 'attack') return base;
  if (action === 'skill') return base + 1;  // stronger move = one more puzzle
  if (action === 'heal') return 1;          // healing is always a single puzzle
  return 0;                                  // defend / potion need no puzzle
}

function createRun(username, rng = Math.random) {
  const run = {
    username, rng,
    events: new EventEmitter(),
    log: [], phase: 'map', won: false,
    floorIdx: 0, step: 0, map: [], room: null,
    cleared: 0, goldEarned: 0, combo: 0, busy: false, pending: null, recorded: false,
    hero: { level: 1, xp: 0, maxHp: 60, hp: 60, maxMp: 20, mp: 20, atk: 12, def: 2, gold: 0, potions: 1, defending: false },
    enemy: null
  };
  wireLog(run);
  buildFloorMap(run);
  run.events.emit('floorEntered', { name: DUNGEON.floors[0].name, number: 1, healed: 0 });
  return run;
}

// ---------- Event listeners (observer pattern) ----------
function wireLog(run) {
  const on = (name, fn) => run.events.on(name, fn);
  const say = msg => run.log.push(msg);
  on('floorEntered', r => say(`Floor ${r.number}: ${r.name}.` + (r.healed ? ` You rest on the stairs (+${r.healed} HP).` : '')));
  on('roomEntered', r => say(r.type === 'combat' || r.type === 'boss' ? `${r.enemy} blocks your way!` : `You enter a ${ROOM_INFO[r.type].label.toLowerCase()} room.`));
  on('treasure', r => say(`You find ${r.gold} gold` + (r.potion ? ' and a potion!' : '.')));
  on('rest', r => say(`You rest at the campfire: +${r.hp} HP, +${r.mp} MP.`));
  on('puzzleResult', r => say(r.timedOut ? 'Time ran out!' : `Puzzles solved: ${r.correct}/${r.total}`));
  on('heroHit', r => say(`You ${r.skill ? 'unleash Power Strike' : 'attack'} for ${r.damage} damage` +
    (r.comboBonus ? ` (combo +${r.comboBonus}%)` : '') + '.'));
  on('heroMiss', () => say('Your attack misses!'));
  on('heroHeal', r => say(r.amount > 0 ? `You heal ${r.amount} HP.` : 'The healing spell fizzles.'));
  on('defend', () => say('You brace for the next hit (damage halved, +4 MP).'));
  on('potion', r => say(`You drink a potion and recover ${r.amount} HP.`));
  on('enemyHit', r => say(`${r.name} ${r.heavy ? 'unleashes a HEAVY attack' : 'attacks'} for ${r.damage} damage` +
    (r.blocked ? ' (blocked half)' : '') + '.'));
  on('enemyDefeated', r => say(`${r.name} is defeated! +${r.xp} XP, +${r.gold} gold.`));
  on('levelUp', r => say(`LEVEL UP! You are now level ${r.level}.`));
  on('heroDefeated', () => say('You have fallen...'));
  on('victory', () => say('The dungeon is conquered. You win!'));
}

// ---------- Dungeon generation ----------
function rollOtherDoor(run) {
  let r = run.rng();
  for (const [type, p] of OTHER_DOOR_ODDS) { if (r < p) return type; r -= p; }
  return 'combat';
}

function buildFloorMap(run) {
  const f = DUNGEON.floors[run.floorIdx];
  const steps = [];
  for (let i = 0; i < f.steps; i++) {
    const fight = { type: 'combat', enemy: pick(run, f.pool) };
    const type = rollOtherDoor(run);
    const other = type === 'combat' ? { type, enemy: pick(run, f.pool) } : { type };
    steps.push(run.rng() < 0.5 ? [fight, other] : [other, fight]);   // door order is random
  }
  steps.push([{ type: 'boss', enemy: f.end }]);                       // every floor ends with its boss
  run.map = steps;
  run.step = 0;
}

function spawnEnemy(run, name) {
  const t = BESTIARY[name];
  run.enemy = { name, ...t, maxHp: t.hp, turn: 0, nextMove: 'normal' };
  run.hero.defending = false;
  run.combo = 0;
}

// ---------- Moving through the dungeon ----------
function enterRoom(run, choice) {
  if (run.phase !== 'map') throw gameError('Doors can only be chosen between rooms.');
  const door = run.map[run.step][Number(choice)];
  if (!Number.isInteger(Number(choice)) || !door) throw gameError('No such door.');
  run.log = [];
  run.room = { ...door };
  run.enemy = null;
  run.events.emit('roomEntered', { type: door.type, enemy: door.enemy });
  const h = run.hero, depth = run.floorIdx;

  if (door.type === 'combat' || door.type === 'boss') {
    spawnEnemy(run, door.enemy);
    run.phase = 'combat';
  } else if (door.type === 'treasure') {
    const gold = 15 + depth * 10 + Math.floor(run.rng() * 10);
    const potion = run.rng() < 0.3;
    h.gold += gold; run.goldEarned += gold;
    if (potion) h.potions++;
    run.events.emit('treasure', { gold, potion });
    run.phase = 'event';
  } else if (door.type === 'rest') {
    const hp = Math.min(h.maxHp - h.hp, Math.round(h.maxHp * 0.4));
    const mp = Math.min(h.maxMp - h.mp, Math.round(h.maxMp * 0.5));
    h.hp += hp; h.mp += mp;
    run.events.emit('rest', { hp, mp });
    run.phase = 'event';
  } else {
    run.phase = 'shop';                                              // merchant: buy potions, then leave
  }
}

// Leave a cleared room / treasure / campfire / merchant and go back to the door choice.
function leaveRoom(run) {
  if (run.phase !== 'event' && run.phase !== 'shop') throw gameError('You cannot leave right now.');
  run.log = [];
  run.enemy = null; run.room = null;
  run.step++;
  if (run.step >= run.map.length) {                                  // floor finished -> descend
    run.floorIdx++;
    const h = run.hero;
    const healed = Math.min(h.maxHp - h.hp, Math.round(h.maxHp * 0.35));   // rest on the stairs
    h.hp += healed; h.mp = Math.min(h.maxMp, h.mp + 6);
    buildFloorMap(run);
    run.events.emit('floorEntered', { name: DUNGEON.floors[run.floorIdx].name, number: run.floorIdx + 1, healed });
  }
  run.phase = 'map';
}

const variance = run => 0.85 + run.rng() * 0.3;

// ---------- Player turn, step 1: choose an action ----------
async function startAction(run, actionName, source, now = Date.now()) {
  if (run.phase !== 'combat') throw gameError('You are not in combat.');
  if (run.pending || run.busy) throw gameError('Finish the current puzzle first.');
  const def = ACTIONS[actionName];
  if (!def) throw gameError('Unknown action.');
  if (run.hero.mp < def.mp) throw gameError('Not enough MP.');
  if (actionName === 'potion' && run.hero.potions < 1) throw gameError('No potions left.');

  run.log = [];
  const n = puzzleCount(actionName, run.enemy.tier);

  if (n === 0) {                              // instant actions: no puzzle
    if (actionName === 'defend') {
      run.hero.defending = true;
      run.hero.mp = Math.min(run.hero.maxMp, run.hero.mp + 4);
      run.events.emit('defend');
    } else {
      run.hero.potions--;
      const amount = Math.min(40, run.hero.maxHp - run.hero.hp);
      run.hero.hp += amount;
      run.events.emit('potion', { amount });
    }
    enemyTurn(run);
    return { puzzles: [], seconds: 0 };
  }

  run.busy = true;                            // block a second request while we await the API
  try {
    const puzzles = await source(n);          // INTEROP: may throw if the third party is down
    run.hero.mp -= def.mp;                    // only pay MP once puzzles were really obtained
    const seconds = n * TIERS[run.enemy.tier].secondsPerPuzzle;
    run.pending = { action: actionName, solutions: puzzles.map(p => p.solution), n, deadline: now + seconds * 1000 };
    return { puzzles: puzzles.map(p => ({ image: p.image })), seconds };
  } finally {
    run.busy = false;
  }
}

// ---------- Player turn, step 2: answer the puzzles ----------
function answer(run, answers, now = Date.now()) {
  const p = run.pending;
  if (!p) throw gameError('No puzzle is waiting for an answer.');
  run.pending = null;
  run.log = [];

  const timedOut = now > p.deadline + GRACE_MS;
  const given = Array.isArray(answers) ? answers : [];
  let correct = 0;
  if (!timedOut) p.solutions.forEach((s, i) => { if (Number.isInteger(given[i]) && given[i] === s) correct++; });
  const ratio = correct / p.n;
  run.events.emit('puzzleResult', { correct, total: p.n, timedOut });

  const hero = run.hero, enemy = run.enemy;
  if (p.action === 'heal') {
    const amount = Math.min(Math.round(hero.maxHp * 0.35) * (ratio === 1 ? 1 : 0), hero.maxHp - hero.hp);
    hero.hp += amount;
    run.events.emit('heroHeal', { amount });
  } else {
    const def = ACTIONS[p.action];
    if (ratio === 0) {
      run.combo = 0;
      run.events.emit('heroMiss');
    } else {
      const comboBonus = Math.min(run.combo, 5) * 10;            // consecutive perfect turns
      const raw = hero.atk * def.power * variance(run) * ratio * (1 + comboBonus / 100);
      const damage = Math.max(1, Math.round(raw) - enemy.def);
      enemy.hp = Math.max(0, enemy.hp - damage);
      run.combo = ratio === 1 ? run.combo + 1 : 0;
      run.events.emit('heroHit', { damage, skill: p.action === 'skill', comboBonus });
    }
  }

  if (enemy.hp <= 0) onEnemyDefeated(run); else enemyTurn(run);
  return { correct, total: p.n, timedOut, solutions: p.solutions };
}

// ---------- Enemy turn ----------
function enemyTurn(run) {
  const e = run.enemy, h = run.hero;
  e.turn++;
  const heavy = e.tier !== 'mob' && e.turn % 3 === 0;           // bosses telegraph a heavy hit every 3rd turn
  let damage = Math.max(1, Math.round(e.atk * variance(run)) - h.def);
  if (heavy) damage *= 2;
  const blocked = h.defending;
  if (blocked) damage = Math.ceil(damage / 2);
  h.defending = false;
  h.hp = Math.max(0, h.hp - damage);
  run.events.emit('enemyHit', { name: e.name, damage, heavy, blocked });
  e.nextMove = e.tier !== 'mob' && (e.turn + 1) % 3 === 0 ? 'heavy' : 'normal';
  if (h.hp <= 0) {
    run.phase = 'over';
    run.events.emit('heroDefeated');
    finish(run);
  }
}

function onEnemyDefeated(run) {
  const e = run.enemy, h = run.hero;
  run.cleared++;
  run.goldEarned += e.gold;
  h.gold += e.gold;
  h.xp += e.xp;
  run.events.emit('enemyDefeated', { name: e.name, xp: e.xp, gold: e.gold });
  while (h.xp >= xpToNext(h.level)) {
    h.xp -= xpToNext(h.level);
    h.level++;
    h.maxHp += 12; h.maxMp += 4; h.atk += 3; h.def += 1;
    h.hp = h.maxHp; h.mp = h.maxMp;                              // full restore on level up
    run.events.emit('levelUp', { level: h.level });
  }
  const lastFloor = run.floorIdx === DUNGEON.floors.length - 1;
  if (run.room.type === 'boss' && lastFloor) {
    run.won = true;
    run.phase = 'over';
    run.events.emit('victory');
    finish(run);
  } else {
    run.phase = 'event';                                         // room cleared: player presses Continue
  }
}

function scoreOf(run) {
  return run.cleared * 100 + run.goldEarned + run.hero.level * 10 + (run.won ? 500 : 0);
}

function finish(run) {
  run.events.emit('runOver', { score: scoreOf(run), cleared: run.cleared, won: run.won });
}

// ---------- Merchant ----------
function buyPotion(run) {
  if (run.phase !== 'shop') throw gameError('You need to find a merchant room to shop.');
  if (run.hero.gold < POTION_PRICE) throw gameError('Not enough gold.');
  run.hero.gold -= POTION_PRICE;
  run.hero.potions++;
}

// ---------- What the browser may see (never the solutions) ----------
function view(run, now = Date.now()) {
  const h = run.hero, e = run.enemy;
  const actions = {};
  for (const [key, def] of Object.entries(ACTIONS)) {
    actions[key] = { label: def.label, mp: def.mp, puzzles: puzzleCount(key, e ? e.tier : 'mob') };
  }
  const floor = DUNGEON.floors[run.floorIdx];
  const doorView = d => ({
    type: d.type, icon: ROOM_INFO[d.type].icon, label: ROOM_INFO[d.type].label,
    enemy: d.enemy ? { name: d.enemy, emoji: BESTIARY[d.enemy].emoji, tierLabel: TIERS[BESTIARY[d.enemy].tier].label } : null
  });
  return {
    phase: run.phase, won: run.won, floor: run.floorIdx + 1, totalFloors: DUNGEON.floors.length,
    map: {
      dungeon: DUNGEON.name, floorName: floor.name,
      step: Math.min(run.step + 1, run.map.length), totalSteps: run.map.length,
      doors: run.phase === 'map' ? run.map[run.step].map(doorView) : null
    },
    room: run.room ? { type: run.room.type, icon: ROOM_INFO[run.room.type].icon, label: ROOM_INFO[run.room.type].label } : null,
    score: scoreOf(run), combo: run.combo, potionPrice: POTION_PRICE, actions,
    hero: { level: h.level, xp: h.xp, xpToNext: xpToNext(h.level), hp: h.hp, maxHp: h.maxHp, mp: h.mp, maxMp: h.maxMp,
            atk: h.atk, def: h.def, gold: h.gold, potions: h.potions, defending: h.defending },
    enemy: e ? { name: e.name, emoji: e.emoji, tier: e.tier, tierLabel: TIERS[e.tier].label,
                 hp: e.hp, maxHp: e.maxHp, nextMove: e.nextMove } : null,
    pending: run.pending ? { n: run.pending.n, msLeft: Math.max(0, run.pending.deadline - now) } : null,
    log: run.log
  };
}

module.exports = { createRun, startAction, answer, enterRoom, leaveRoom, buyPotion, view, scoreOf,
                   BESTIARY, DUNGEON, TIERS, ACTIONS, POTION_PRICE, GRACE_MS };
