// game.js - RPG engine. Own code. No I/O: puzzles come in through an injected `source`
// function, randomness through an injected `rng`, so the rules are fully unit-testable.
//
// EVENT-DRIVEN design: the engine never writes log text directly. It emits events
// ('heroHit', 'enemyHit', 'levelUp', ...) on a per-run EventEmitter and listeners react
// (here: build the combat log; the server also listens for 'runOver' to save the score).
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

const ENCOUNTERS = [
  { name: 'Slime',           emoji: '🟢', tier: 'mob',     hp: 30,  atk: 6,  def: 0, xp: 14, gold: 10 },
  { name: 'Goblin',          emoji: '👺', tier: 'mob',     hp: 40,  atk: 8,  def: 1, xp: 18, gold: 12 },
  { name: 'Orc',             emoji: '👹', tier: 'mob',     hp: 55,  atk: 10, def: 2, xp: 24, gold: 16 },
  { name: 'Skeleton Knight', emoji: '💀', tier: 'midboss', hp: 75,  atk: 12, def: 3, xp: 55, gold: 40 },
  { name: 'Wraith',          emoji: '👻', tier: 'mob',     hp: 60,  atk: 11, def: 3, xp: 35, gold: 25 },
  { name: 'Ancient Dragon',  emoji: '🐉', tier: 'boss',    hp: 130, atk: 17, def: 4, xp: 150, gold: 100 }
];

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
    log: [], floor: 0, phase: 'combat', won: false,
    cleared: 0, goldEarned: 0, combo: 0, busy: false, pending: null, recorded: false,
    hero: { level: 1, xp: 0, maxHp: 60, hp: 60, maxMp: 20, mp: 20, atk: 12, def: 2, gold: 0, potions: 1, defending: false },
    enemy: null
  };
  wireLog(run);
  spawnEnemy(run);
  return run;
}

// ---------- Event listeners (observer pattern) ----------
function wireLog(run) {
  const on = (name, fn) => run.events.on(name, fn);
  const say = msg => run.log.push(msg);
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

function spawnEnemy(run) {
  const t = ENCOUNTERS[run.floor];
  run.enemy = { ...t, maxHp: t.hp, turn: 0, nextMove: 'normal' };
  run.hero.defending = false;
  run.combo = 0;
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
  if (run.floor === ENCOUNTERS.length - 1) {
    run.won = true;
    run.phase = 'over';
    run.events.emit('victory');
    finish(run);
  } else {
    run.phase = 'shop';
  }
}

function scoreOf(run) {
  return run.cleared * 100 + run.goldEarned + run.hero.level * 10 + (run.won ? 500 : 0);
}

function finish(run) {
  run.events.emit('runOver', { score: scoreOf(run), cleared: run.cleared, won: run.won });
}

// ---------- Between fights ----------
function buyPotion(run) {
  if (run.phase !== 'shop') throw gameError('The shop is only open between fights.');
  if (run.hero.gold < POTION_PRICE) throw gameError('Not enough gold.');
  run.hero.gold -= POTION_PRICE;
  run.hero.potions++;
}

function nextFloor(run) {
  if (run.phase !== 'shop') throw gameError('Finish the fight first.');
  run.floor++;
  run.phase = 'combat';
  run.log = [];
  const h = run.hero;                                            // short rest between fights
  h.hp = Math.min(h.maxHp, h.hp + Math.round(h.maxHp * 0.35));
  h.mp = Math.min(h.maxMp, h.mp + 6);
  spawnEnemy(run);
}

// ---------- What the browser may see (never the solutions) ----------
function view(run, now = Date.now()) {
  const h = run.hero, e = run.enemy;
  const actions = {};
  for (const [key, def] of Object.entries(ACTIONS)) {
    actions[key] = { label: def.label, mp: def.mp, puzzles: puzzleCount(key, e.tier) };
  }
  return {
    phase: run.phase, won: run.won, floor: run.floor + 1, totalFloors: ENCOUNTERS.length,
    score: scoreOf(run), combo: run.combo, potionPrice: POTION_PRICE, actions,
    hero: { level: h.level, xp: h.xp, xpToNext: xpToNext(h.level), hp: h.hp, maxHp: h.maxHp, mp: h.mp, maxMp: h.maxMp,
            atk: h.atk, def: h.def, gold: h.gold, potions: h.potions, defending: h.defending },
    enemy: { name: e.name, emoji: e.emoji, tier: e.tier, tierLabel: TIERS[e.tier].label,
             hp: e.hp, maxHp: e.maxHp, nextMove: e.nextMove },
    pending: run.pending ? { n: run.pending.n, msLeft: Math.max(0, run.pending.deadline - now) } : null,
    log: run.log
  };
}

module.exports = { createRun, startAction, answer, buyPotion, nextFloor, view, scoreOf,
                   ENCOUNTERS, TIERS, ACTIONS, POTION_PRICE, GRACE_MS };
