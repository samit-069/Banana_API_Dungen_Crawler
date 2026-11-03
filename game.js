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

// ---------- Equipment (pure data: add gear here without touching the rules) ----------
const EQUIP_SLOTS = ['weapon', 'armor', 'trinket'];
const RARITIES = {
  common:   { label: 'Common',   mult: 1.00, order: 0 },
  uncommon: { label: 'Uncommon', mult: 1.35, order: 1 },
  rare:     { label: 'Rare',     mult: 1.75, order: 2 },
  epic:     { label: 'Epic',     mult: 2.40, order: 3 }
};
const ITEMS = {
  rusty_dagger:    { name: 'Rusty Dagger',    icon: '🗡️', slot: 'weapon',  stats: { atk: 2 },                     value: 12 },
  short_sword:     { name: 'Short Sword',     icon: '⚔️', slot: 'weapon',  stats: { atk: 4 },                     value: 25 },
  iron_axe:        { name: 'Iron Axe',        icon: '🪓', slot: 'weapon',  stats: { atk: 7 },                     value: 45 },
  dragon_fang:     { name: 'Dragon Fang',     icon: '🐲', slot: 'weapon',  stats: { atk: 11 },                    value: 90 },
  cloth_vest:      { name: 'Cloth Vest',      icon: '🧥', slot: 'armor',   stats: { def: 1, maxHp: 5 },           value: 14 },
  leather_armor:   { name: 'Leather Armor',   icon: '🥋', slot: 'armor',   stats: { def: 2, maxHp: 10 },          value: 30 },
  chainmail:       { name: 'Chainmail',       icon: '🛡️', slot: 'armor',   stats: { def: 4, maxHp: 18 },          value: 55 },
  dragonscale:     { name: 'Dragonscale',     icon: '🐉', slot: 'armor',   stats: { def: 6, maxHp: 30 },          value: 100 },
  lucky_charm:     { name: 'Lucky Charm',     icon: '🍀', slot: 'trinket', stats: { maxMp: 5 },                   value: 18 },
  ember_ring:      { name: 'Ember Ring',      icon: '💍', slot: 'trinket', stats: { atk: 2, maxMp: 5 },           value: 40 },
  vitality_amulet: { name: 'Vitality Amulet', icon: '📿', slot: 'trinket', stats: { maxHp: 15 },                  value: 40 },
  banana_idol:     { name: 'Banana Idol',     icon: '🍌', slot: 'trinket', stats: { atk: 3, def: 1, maxHp: 10 }, value: 80 }
};
// Fallback tables; each enemy normally points at its own loot in BESTIARY.
const LOOT_BY_TIER = {
  mob:     ['rusty_dagger', 'cloth_vest', 'lucky_charm'],
  midboss: ['short_sword', 'leather_armor', 'ember_ring', 'vitality_amulet'],
  boss:    ['iron_axe', 'chainmail', 'dragon_fang', 'dragonscale', 'banana_idol']
};
const DROP_CHANCE = { mob: 0.35, midboss: 0.75, boss: 1.0 };
const RARITY_ODDS = {
  mob:     [['common', 0.70], ['uncommon', 0.25], ['rare', 0.05]],
  midboss: [['common', 0.30], ['uncommon', 0.45], ['rare', 0.22], ['epic', 0.03]],
  boss:    [['uncommon', 0.25], ['rare', 0.55], ['epic', 0.20]]
};
const STAT_LABELS = { atk: 'ATK', def: 'DEF', maxHp: 'HP', maxMp: 'MP' };
const statText = stats => Object.entries(stats).map(([k, v]) => `+${v} ${STAT_LABELS[k] || k}`).join(', ');

// ---------- Enchantments (one per item; tier depends on puzzle performance) ----------
// `solved` counts correct answers given before the turn's deadline during this run, so
// accurate, timely puzzle play directly unlocks stronger magic.
const ENCHANTS = {
  sharp:  { name: 'Sharpened', icon: '🔪', stat: 'atk',   base: 2 },
  warded: { name: 'Warded',    icon: '🛡️', stat: 'def',   base: 2 },
  vital:  { name: 'Vital',     icon: '❤️', stat: 'maxHp', base: 8 },
  arcane: { name: 'Arcane',    icon: '🔷', stat: 'maxMp', base: 4 }
};
const ENCHANT_TIERS = [
  { tier: 1, name: 'Lesser',   solved: 3,  gold: 20,  mult: 1 },
  { tier: 2, name: 'Greater',  solved: 8,  gold: 45,  mult: 2 },
  { tier: 3, name: 'Superior', solved: 15, gold: 80,  mult: 3 },
  { tier: 4, name: 'Mythic',   solved: 25, gold: 140, mult: 4 }
];

// ---------- Content (pure data: add monsters / floors here without touching the rules) ----------
const BESTIARY = {
  Slime:             { emoji: '🟢', tier: 'mob',     hp: 30,  atk: 6,  def: 0, xp: 14,  gold: 10,  loot: ['cloth_vest', 'lucky_charm'] },
  Rat:               { emoji: '🐀', tier: 'mob',     hp: 26,  atk: 7,  def: 0, xp: 12,  gold: 8,   loot: ['rusty_dagger', 'lucky_charm'] },
  Goblin:            { emoji: '👺', tier: 'mob',     hp: 40,  atk: 8,  def: 1, xp: 18,  gold: 12,  loot: ['rusty_dagger', 'cloth_vest'] },
  Skeleton:          { emoji: '🦴', tier: 'mob',     hp: 50,  atk: 10, def: 2, xp: 24,  gold: 15,  loot: ['short_sword', 'cloth_vest'] },
  Orc:               { emoji: '👹', tier: 'mob',     hp: 55,  atk: 11, def: 2, xp: 28,  gold: 18,  loot: ['short_sword', 'leather_armor'] },
  Wraith:            { emoji: '👻', tier: 'mob',     hp: 60,  atk: 12, def: 3, xp: 34,  gold: 24,  loot: ['ember_ring', 'lucky_charm'] },
  Gargoyle:          { emoji: '🗿', tier: 'mob',     hp: 70,  atk: 13, def: 4, xp: 40,  gold: 28,  loot: ['chainmail', 'vitality_amulet'] },
  'Skeleton Knight': { emoji: '💀', tier: 'midboss', hp: 75,  atk: 12, def: 3, xp: 55,  gold: 40,  loot: ['short_sword', 'leather_armor', 'ember_ring'] },
  'Orc Warlord':     { emoji: '🪓', tier: 'midboss', hp: 95,  atk: 15, def: 4, xp: 80,  gold: 60,  loot: ['iron_axe', 'chainmail', 'vitality_amulet'] },
  'Ancient Dragon':  { emoji: '🐉', tier: 'boss',    hp: 130, atk: 17, def: 4, xp: 150, gold: 100, loot: ['dragon_fang', 'dragonscale', 'banana_idol'] }
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
const OTHER_DOOR_ODDS = [['combat', 0.35], ['treasure', 0.18], ['rest', 0.22], ['shop', 0.10], ['enchant', 0.15]];

const ROOM_INFO = {
  combat:   { icon: '⚔️', label: 'Monster' },
  boss:     { icon: '☠️', label: 'Floor boss' },
  treasure: { icon: '💰', label: 'Treasure' },
  rest:     { icon: '🔥', label: 'Campfire' },
  shop:     { icon: '🛒', label: 'Merchant' },
  enchant:  { icon: '🔮', label: 'Enchanter' }
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

// ---------- Equipment rules ----------
// Sum of every equipped item's stats. Gear stats are final (rarity already applied at drop time).
function equipmentBonus(hero) {
  const bonus = { atk: 0, def: 0, maxHp: 0, maxMp: 0 };
  for (const slot of EQUIP_SLOTS) {
    const item = hero.equipment[slot];
    if (!item) continue;
    for (const stats of [item.stats, item.enchant && item.enchant.stats]) {
      if (!stats) continue;
      for (const [stat, amount] of Object.entries(stats)) bonus[stat] = (bonus[stat] || 0) + amount;
    }
  }
  return bonus;
}

// Derived stats always come from base + equipped gear, so swapping can never double-count.
// A higher max stat grants the extra points immediately; a lower one clamps current values.
function recalcHero(hero) {
  const bonus = equipmentBonus(hero);
  const nextMaxHp = hero.base.maxHp + bonus.maxHp;
  const nextMaxMp = hero.base.maxMp + bonus.maxMp;
  const hpGain = Math.max(0, nextMaxHp - hero.maxHp);
  const mpGain = Math.max(0, nextMaxMp - hero.maxMp);
  hero.maxHp = nextMaxHp;
  hero.maxMp = nextMaxMp;
  hero.atk = hero.base.atk + bonus.atk;
  hero.def = hero.base.def + bonus.def;
  hero.hp = Math.max(0, Math.min(hero.maxHp, hero.hp + hpGain));
  hero.mp = Math.max(0, Math.min(hero.maxMp, hero.mp + mpGain));
  return bonus;
}

function rollRarity(run, tier) {
  let r = run.rng();
  for (const [rarity, chance] of RARITY_ODDS[tier]) { if (r < chance) return rarity; r -= chance; }
  return RARITY_ODDS[tier][RARITY_ODDS[tier].length - 1][0];
}

function makeItem(run, baseId, rarity) {
  const base = ITEMS[baseId], meta = RARITIES[rarity];
  const stats = {};
  for (const [stat, amount] of Object.entries(base.stats)) stats[stat] = Math.max(1, Math.round(amount * meta.mult));
  return {
    id: run.hero.nextItemId++, key: baseId, name: base.name, icon: base.icon, slot: base.slot,
    rarity, rarityLabel: meta.label, stats, value: Math.round(base.value * meta.mult)
  };
}

// Called when an enemy dies: roll the tier's drop chance, then that enemy's own loot table.
function rollLoot(run) {
  const e = run.enemy;
  if (!e || run.rng() >= (DROP_CHANCE[e.tier] ?? 0)) return null;
  const table = e.loot && e.loot.length ? e.loot : (LOOT_BY_TIER[e.tier] || []);
  if (!table.length) return null;
  const item = makeItem(run, pick(run, table), rollRarity(run, e.tier));
  run.hero.inventory.push(item);
  return item;
}

function canChangeEquipment(run) {
  if (run.phase === 'over') throw gameError('The run is over.');
  if (run.pending || run.busy) throw gameError('Finish the current puzzle first.');
}

// Move an item from the bag into its slot; anything already there goes back to the bag.
function equipItem(run, itemId) {
  canChangeEquipment(run);
  const h = run.hero;
  const idx = h.inventory.findIndex(item => item.id === Number(itemId));
  if (idx === -1) throw gameError('That item is not in your inventory.');
  const item = h.inventory[idx];
  const replaced = h.equipment[item.slot];
  h.inventory.splice(idx, 1);
  h.equipment[item.slot] = item;
  if (replaced) h.inventory.push(replaced);
  const bonus = recalcHero(h);
  run.events.emit('equipped', { item, replaced, bonus });
  return item;
}

function unequipItem(run, slot) {
  canChangeEquipment(run);
  if (!EQUIP_SLOTS.includes(slot)) throw gameError('Unknown equipment slot.');
  const h = run.hero;
  const item = h.equipment[slot];
  if (!item) throw gameError('Nothing is equipped in that slot.');
  h.equipment[slot] = null;
  h.inventory.push(item);
  const bonus = recalcHero(h);
  run.events.emit('unequipped', { item, slot, bonus });
  return item;
}

// ---------- Enchanting ----------
// Highest tier the player has earned this run, or null before the first threshold.
function availableEnchantTier(run) {
  let unlocked = null;
  for (const tier of ENCHANT_TIERS) if (run.puzzleStats.solved >= tier.solved) unlocked = tier;
  return unlocked;
}

// Apply (or replace) the enchantment on an equipped or bagged item. Only in an enchanter room.
function enchantItem(run, itemId, enchantKey) {
  if (run.phase !== 'enchant') throw gameError('You need to find an enchanter to enchant gear.');
  if (run.pending || run.busy) throw gameError('Finish the current puzzle first.');
  const tier = availableEnchantTier(run);
  if (!tier) throw gameError(`Solve ${ENCHANT_TIERS[0].solved} puzzles in time to unlock enchanting.`);
  const def = ENCHANTS[enchantKey];
  if (!def) throw gameError('Unknown enchantment.');
  const h = run.hero;
  const item = [...EQUIP_SLOTS.map(slot => h.equipment[slot]), ...h.inventory]
    .find(candidate => candidate && candidate.id === Number(itemId));
  if (!item) throw gameError('That item is not in your equipment or bag.');
  if (h.gold < tier.gold) throw gameError('Not enough gold.');

  h.gold -= tier.gold;
  item.enchant = {
    key: enchantKey, name: def.name, icon: def.icon,
    tier: tier.tier, tierName: tier.name,
    stats: { [def.stat]: def.base * tier.mult },
    text: `+${def.base * tier.mult} ${STAT_LABELS[def.stat]}`
  };
  recalcHero(h);
  run.events.emit('enchanted', { item, enchant: item.enchant, cost: tier.gold });
  return item;
}

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
    log: [], phase: 'map', won: false, startedAt: Date.now(),
    floorIdx: 0, step: 0, map: [], room: null,
    cleared: 0, goldEarned: 0, combo: 0, busy: false, pending: null, recorded: false,
    puzzleStats: { solved: 0, attempted: 0, perfectTurns: 0 },
    hero: {
      level: 1, xp: 0,
      base: { maxHp: 60, maxMp: 20, atk: 12, def: 2 },
      maxHp: 60, hp: 60, maxMp: 20, mp: 20, atk: 12, def: 2,
      gold: 0, potions: 1, defending: false,
      equipment: { weapon: null, armor: null, trinket: null },
      inventory: [], nextItemId: 1
    },
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
  on('roomEntered', r => say(r.type === 'combat' || r.type === 'boss' ? `${r.enemy} blocks your way!` : `You enter the ${ROOM_INFO[r.type].label.toLowerCase()} room.`));
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
  on('loot', r => say(`Loot! ${r.item.icon} ${r.item.rarityLabel} ${r.item.name} (${statText(r.item.stats)}) goes into your bag.`));
  on('equipped', r => say(`Equipped ${r.item.icon} ${r.item.name}` + (r.replaced ? `, stowing ${r.replaced.name}.` : '.')));
  on('unequipped', r => say(`Unequipped ${r.item.icon} ${r.item.name}.`));
  on('enchanted', r => say(`Enchanted ${r.item.icon} ${r.item.name}: ${r.enchant.icon} ${r.enchant.tierName} ${r.enchant.name} (${r.enchant.text}) for ${r.cost} gold.`));
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
  } else if (door.type === 'enchant') {
    run.phase = 'enchant';                                           // enchanter: spend gold on gear
  } else {
    run.phase = 'shop';                                              // merchant: buy potions, then leave
  }
}

// Leave a cleared room / treasure / campfire / merchant / enchanter and go back to the door choice.
function leaveRoom(run) {
  if (run.phase !== 'event' && run.phase !== 'shop' && run.phase !== 'enchant') {
    throw gameError('You cannot leave right now.');
  }
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
  run.puzzleStats.attempted += p.n;
  run.puzzleStats.solved += correct;                       // correct within the deadline only
  if (ratio === 1) run.puzzleStats.perfectTurns++;
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
    h.base.maxHp += 12; h.base.maxMp += 4; h.base.atk += 3; h.base.def += 1;
    recalcHero(h);
    h.hp = h.maxHp; h.mp = h.maxMp;                              // full restore on level up
    run.events.emit('levelUp', { level: h.level });
  }
  const loot = rollLoot(run);
  if (loot) run.events.emit('loot', { item: loot });
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
  run.events.emit('runOver', {
    score: scoreOf(run), cleared: run.cleared, won: run.won,
    gold: run.goldEarned, level: run.hero.level, floor: run.floorIdx + 1,
    durationMs: Date.now() - run.startedAt
  });
}

// ---------- Merchant ----------
function buyPotion(run) {
  if (run.phase !== 'shop') throw gameError('You need to find a merchant room to shop.');
  if (run.hero.gold < POTION_PRICE) throw gameError('Not enough gold.');
  run.hero.gold -= POTION_PRICE;
  run.hero.potions++;
}

// ---------- Enchanter room view ----------
// Lists every enchantment the player can buy right now plus the tier that is unlocked.
function enchantingView(run) {
  if (run.phase !== 'enchant') return null;
  const h = run.hero;
  const tier = availableEnchantTier(run);
  const items = [...EQUIP_SLOTS.map(slot => h.equipment[slot]), ...h.inventory]
    .filter(Boolean)
    .map(item => ({
      id: item.id, name: item.name, icon: item.icon, slot: item.slot, rarity: item.rarityLabel,
      equipped: EQUIP_SLOTS.some(slot => h.equipment[slot] === item),
      enchant: item.enchant || null
    }));
  return {
    tier: tier && { ...tier },
    next: ENCHANT_TIERS.find(t => !tier || t.tier === tier.tier + 1) || null,
    gold: h.gold,
    options: Object.entries(ENCHANTS).map(([key, def]) => ({
      key, name: def.name, icon: def.icon, stat: def.stat, statLabel: STAT_LABELS[def.stat],
      base: def.base, amount: def.base * (tier ? tier.mult : 1),
      cost: tier ? tier.gold : null, affordable: Boolean(tier) && h.gold >= tier.gold
    })),
    items
  };
}

// ---------- What the browser may see (never the solutions) ----------
function view(run, now = Date.now()) {
  const h = run.hero, e = run.enemy;
  const actions = {};
  for (const [key, def] of Object.entries(ACTIONS)) {
    actions[key] = { label: def.label, mp: def.mp, puzzles: puzzleCount(key, e ? e.tier : 'mob') };
  }
  const floor = DUNGEON.floors[run.floorIdx];
  const itemView = item => item && ({
    id: item.id, key: item.key, name: item.name, icon: item.icon, slot: item.slot,
    rarity: item.rarity, rarityLabel: item.rarityLabel, stats: item.stats,
    statText: statText(item.stats), value: item.value,
    enchant: item.enchant || null
  });
  const equipment = {};
  for (const slot of EQUIP_SLOTS) equipment[slot] = itemView(run.hero.equipment[slot]);
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
            atk: h.atk, def: h.def, gold: h.gold, potions: h.potions, defending: h.defending,
            base: { ...h.base }, bonus: equipmentBonus(h) },
    equipment,
    inventory: h.inventory.map(itemView),
    puzzleStats: { ...run.puzzleStats },
    enchanting: enchantingView(run),
    enemy: e ? { name: e.name, emoji: e.emoji, tier: e.tier, tierLabel: TIERS[e.tier].label,
                 hp: e.hp, maxHp: e.maxHp, nextMove: e.nextMove } : null,
    pending: run.pending ? { n: run.pending.n, msLeft: Math.max(0, run.pending.deadline - now) } : null,
    log: run.log
  };
}

module.exports = { createRun, startAction, answer, enterRoom, leaveRoom, buyPotion, equipItem, unequipItem, enchantItem, view, scoreOf,
                   BESTIARY, DUNGEON, TIERS, ACTIONS, ITEMS, RARITIES, EQUIP_SLOTS, LOOT_BY_TIER, ENCHANTS, ENCHANT_TIERS,
                   POTION_PRICE, GRACE_MS };
