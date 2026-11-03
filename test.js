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

// Start a run and walk into a combat room against a chosen monster (forced, so tests are deterministic).
function inFight(enemyName = 'Slime') {
  const run = game.createRun('u', rng);
  const i = run.map[0].findIndex(d => d.type === 'combat');
  run.map[0][i] = { type: 'combat', enemy: enemyName };
  game.enterRoom(run, i);
  return run;
}
const doorIndex = (run, type) => run.map[run.step].findIndex(d => d.type === type);

// ---------- Engine unit tests ----------
test('mob attack costs 1 puzzle, mid-boss 2, boss attack 3, skill adds one', () => {
  const run = inFight('Slime');
  const v = game.view(run);
  assert.strictEqual(v.actions.attack.puzzles, 1);
  assert.strictEqual(v.actions.skill.puzzles, 2);
  assert.strictEqual(game.view(inFight('Skeleton Knight')).actions.attack.puzzles, 2);
  const b = game.view(inFight('Ancient Dragon'));
  assert.strictEqual(b.actions.attack.puzzles, 3);
  assert.strictEqual(b.actions.skill.puzzles, 4);
  assert.strictEqual(b.actions.heal.puzzles, 1);
});

test('correct answer damages enemy; solutions never appear in the view', async () => {
  const run = inFight();
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
  const run = inFight();
  run.combo = 3;
  await game.startAction(run, 'attack', SOURCE);
  const before = run.enemy.hp;
  game.answer(run, ['7']);                              // string is not accepted
  assert.strictEqual(run.enemy.hp, before);
  assert.strictEqual(run.combo, 0);
});

test('answering after the deadline counts as a timeout', async () => {
  const run = inFight();
  await game.startAction(run, 'attack', SOURCE, 1000);
  const r = game.answer(run, [7], 1000 + 20000 + game.GRACE_MS + 1);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.correct, 0);
});

test('skill costs MP only after puzzles are fetched; source failure uses no turn', async () => {
  const run = inFight();
  await assert.rejects(game.startAction(run, 'skill', async () => { throw new Error('down'); }));
  assert.strictEqual(run.hero.mp, 20);
  assert.strictEqual(run.pending, null);
  assert.strictEqual(run.busy, false);
  await game.startAction(run, 'skill', SOURCE);
  assert.strictEqual(run.hero.mp, 12);
});

test('cannot start a second action while a puzzle is pending', async () => {
  const run = inFight();
  await game.startAction(run, 'attack', SOURCE);
  await assert.rejects(game.startAction(run, 'attack', SOURCE), /Finish the current puzzle/);
});

test('defend halves the next hit and restores MP; potion heals', async () => {
  const run = inFight();
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
  const run = inFight('Skeleton Knight');
  run.enemy.maxHp = run.enemy.hp = 999; run.enemy.turn = 1;
  run.hero.maxHp = run.hero.hp = 500;
  await game.startAction(run, 'defend', SOURCE);          // enemy turn 2
  assert.strictEqual(run.enemy.nextMove, 'heavy');
  const hp = run.hero.hp;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7, 7]);                               // enemy turn 3 = heavy
  assert.ok(hp - run.hero.hp >= (12 - 2) * 2 - 1);
});

test('killing an enemy grants xp/gold and levels up; room ends; merchant sells potions only in a shop room', async () => {
  const run = inFight();
  run.enemy.hp = 1;
  run.hero.xp = 20;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7]);
  assert.strictEqual(run.phase, 'event');                // room cleared, waiting for Continue
  assert.strictEqual(run.hero.level, 2);
  assert.strictEqual(run.hero.hp, run.hero.maxHp);
  assert.strictEqual(run.hero.gold, 10);
  assert.throws(() => game.buyPotion(run), /merchant/);  // not a shop room
  game.leaveRoom(run);
  assert.strictEqual(run.phase, 'map');
  assert.strictEqual(run.step, 1);
  // force a merchant at the next step and shop there
  run.map[1][0] = { type: 'shop' };
  game.enterRoom(run, 0);
  assert.strictEqual(run.phase, 'shop');
  assert.throws(() => game.buyPotion(run), /Not enough gold/);   // potion costs 15, hero has 10
  run.hero.gold = 20;
  game.buyPotion(run);
  assert.strictEqual(run.hero.potions, 2);
  assert.strictEqual(run.hero.gold, 5);
});

test('dying ends the run and fires runOver exactly once', async () => {
  const run = inFight();
  let fired = 0;
  run.events.on('runOver', () => fired++);
  run.hero.hp = 1;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [0]);
  assert.strictEqual(run.phase, 'over');
  assert.strictEqual(fired, 1);
  await assert.rejects(game.startAction(run, 'attack', SOURCE), /not in combat/);
});

// ---------- Dungeon structure ----------
test('every floor has choice steps (a fight is always offered) and ends with its boss', () => {
  for (let n = 0; n < 50; n++) {                          // random dungeons, same guarantees every time
    const run = game.createRun('u', Math.random);
    assert.strictEqual(run.map.length, game.DUNGEON.floors[0].steps + 1);
    run.map.slice(0, -1).forEach(doors => {
      assert.strictEqual(doors.length, 2);
      assert.ok(doors.some(d => d.type === 'combat'));
    });
    const last = run.map[run.map.length - 1];
    assert.strictEqual(last.length, 1);
    assert.strictEqual(last[0].type, 'boss');
    assert.strictEqual(last[0].enemy, game.DUNGEON.floors[0].end);
  }
});

test('doors: validated, only usable between rooms; combat blocks navigation', async () => {
  const run = game.createRun('u', rng);
  assert.strictEqual(run.phase, 'map');
  assert.throws(() => game.enterRoom(run, 5), /No such door/);
  assert.throws(() => game.enterRoom(run, 'x'), /No such door/);
  await assert.rejects(game.startAction(run, 'attack', SOURCE), /not in combat/);
  game.enterRoom(run, doorIndex(run, 'combat'));
  assert.strictEqual(run.phase, 'combat');
  assert.throws(() => game.enterRoom(run, 0), /between rooms/);
  assert.throws(() => game.leaveRoom(run), /cannot leave/);
});

test('treasure gives gold, campfire heals, both end in an event room you can leave', () => {
  const run = game.createRun('u', rng);
  run.map[0][0] = { type: 'treasure' }; run.map[1][0] = { type: 'rest' };
  game.enterRoom(run, 0);
  assert.strictEqual(run.phase, 'event');
  assert.ok(run.hero.gold >= 15);
  assert.strictEqual(run.enemy, null);
  game.leaveRoom(run);
  run.hero.hp = 20; run.hero.mp = 0;
  game.enterRoom(run, 0);
  assert.strictEqual(run.hero.hp, 20 + Math.round(60 * 0.4));
  assert.strictEqual(run.hero.mp, 10);
  game.leaveRoom(run);
  assert.strictEqual(run.step, 2);
});

test('beating a floor boss descends to the next floor with a fresh map and a small heal', async () => {
  const run = game.createRun('u', rng);
  run.step = run.map.length - 1;                          // jump to the boss room
  game.enterRoom(run, 0);
  assert.strictEqual(run.enemy.tier, 'midboss');
  run.enemy.hp = 1; run.hero.hp = 30;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7, 7]);
  assert.strictEqual(run.phase, 'event');
  game.leaveRoom(run);
  assert.strictEqual(run.floorIdx, 1);
  assert.strictEqual(run.step, 0);
  assert.strictEqual(run.phase, 'map');
  assert.ok(run.hero.hp > 30);
  assert.ok(game.view(run).log.some(l => /Bone Halls/.test(l)));
});

test('a perfect player can win the whole dungeon through every floor', async () => {
  const run = game.createRun('u', rng);
  let guard = 0, floorsSeen = new Set();
  while (run.phase !== 'over' && guard++ < 3000) {
    floorsSeen.add(run.floorIdx);
    if (run.phase === 'map') {
      const doors = run.map[run.step], low = run.hero.hp < run.hero.maxHp * 0.55;
      const want = low ? ['rest', 'combat'] : ['combat'];
      const idx = want.map(t => doors.findIndex(d => d.type === t)).find(i => i >= 0);
      game.enterRoom(run, idx === undefined ? 0 : idx); continue;
    }
    if (run.phase === 'shop') { while (run.hero.gold >= 15 && run.hero.potions < 3) game.buyPotion(run); game.leaveRoom(run); continue; }
    if (run.phase === 'event') { game.leaveRoom(run); continue; }
    const h = run.hero, e = run.enemy;
    const a = e.nextMove === 'heavy' && h.hp < h.maxHp * 0.6 ? 'defend'
      : h.hp < h.maxHp * 0.35 && h.potions > 0 ? 'potion'
      : h.hp < h.maxHp * 0.4 && h.mp >= 6 ? 'heal'
      : h.mp >= 8 ? 'skill' : 'attack';
    const s = await game.startAction(run, a, SOURCE);
    if (s.puzzles.length) game.answer(run, s.puzzles.map(() => 7));
  }
  assert.strictEqual(run.won, true);
  assert.strictEqual(floorsSeen.size, game.DUNGEON.floors.length);       // had to pass through all floors
  assert.strictEqual(run.floorIdx, game.DUNGEON.floors.length - 1);
});
// ---------- Equipment & loot ----------
test('bosses always drop from their own loot table; rarity scales the stats', async () => {
  const run = inFight('Ancient Dragon');
  run.enemy.hp = 1;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7, 7, 7]);
  assert.strictEqual(run.hero.inventory.length, 1);                 // boss drop chance is 100%
  const item = run.hero.inventory[0];
  assert.strictEqual(item.key, 'dragonscale');                      // rng 0.5 picks the middle entry
  assert.strictEqual(item.rarity, 'rare');
  assert.deepStrictEqual(item.stats, { def: 11, maxHp: 53 });       // base 6/30 * rare 1.75
  const v = game.view(run);
  assert.strictEqual(v.inventory.length, 1);
  assert.strictEqual(v.inventory[0].rarityLabel, 'Rare');
  assert.strictEqual(v.inventory[0].statText, '+11 DEF, +53 HP');
  assert.strictEqual(v.equipment.weapon, null);
  assert.ok(v.log.some(l => /Loot! .*Dragonscale/.test(l)));
});

test('mob drops are chance-based and come from that enemy, not the tier fallback', async () => {
  const lucky = () => 0;                                            // every roll succeeds, common rarity
  const run = game.createRun('u', lucky);
  const i = run.map[0].findIndex(d => d.type === 'combat');
  run.map[0][i] = { type: 'combat', enemy: 'Slime' };
  game.enterRoom(run, i);
  run.enemy.hp = 1;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7]);
  assert.strictEqual(run.hero.inventory.length, 1);
  assert.strictEqual(run.hero.inventory[0].key, 'cloth_vest');      // Slime's own table
  assert.strictEqual(run.hero.inventory[0].rarity, 'common');

  const unlucky = inFight('Slime');                                 // rng 0.5 > 35% drop chance
  unlucky.enemy.hp = 1;
  await game.startAction(unlucky, 'attack', SOURCE);
  game.answer(unlucky, [7]);
  assert.strictEqual(unlucky.hero.inventory.length, 0);
});

test('equipping gear adds stats, swapping stows the old item, unequipping removes the bonus', () => {
  const run = inFight('Slime');
  const h = run.hero;
  h.inventory.push(
    { id: 101, key: 'short_sword', name: 'Short Sword', icon: '⚔️', slot: 'weapon', rarity: 'common', rarityLabel: 'Common', stats: { atk: 4 }, value: 25 },
    { id: 102, key: 'iron_axe', name: 'Iron Axe', icon: '🪓', slot: 'weapon', rarity: 'rare', rarityLabel: 'Rare', stats: { atk: 12 }, value: 79 },
    { id: 103, key: 'leather_armor', name: 'Leather Armor', icon: '🥋', slot: 'armor', rarity: 'common', rarityLabel: 'Common', stats: { def: 2, maxHp: 10 }, value: 30 }
  );
  const atk = h.atk, def = h.def, maxHp = h.maxHp, hp = h.hp;

  game.equipItem(run, 101);
  assert.strictEqual(h.equipment.weapon.name, 'Short Sword');
  assert.strictEqual(h.atk, atk + 4);
  assert.strictEqual(h.inventory.length, 2);

  game.equipItem(run, 102);                                         // swap the slot
  assert.strictEqual(h.equipment.weapon.name, 'Iron Axe');
  assert.strictEqual(h.atk, atk + 12);                              // not atk + 4 + 12
  assert.ok(h.inventory.some(i => i.name === 'Short Sword'));

  game.equipItem(run, 103);                                         // armor also raises the cap and current HP
  assert.strictEqual(h.maxHp, maxHp + 10);
  assert.strictEqual(h.hp, hp + 10);
  assert.strictEqual(h.def, def + 2);

  game.unequipItem(run, 'weapon');
  assert.strictEqual(h.equipment.weapon, null);
  assert.strictEqual(h.atk, atk);
  game.unequipItem(run, 'armor');
  assert.strictEqual(h.maxHp, maxHp);
  assert.strictEqual(h.hp, hp);                                     // clamped back down
  assert.strictEqual(h.def, def);
  assert.strictEqual(h.inventory.length, 3);

  const v = game.view(run);
  assert.deepStrictEqual(v.hero.bonus, { atk: 0, def: 0, maxHp: 0, maxMp: 0 });
  assert.strictEqual(v.inventory.length, 3);
});

test('equipment changes are rejected for bad ids/slots and while a puzzle is pending', async () => {
  const run = inFight('Slime');
  assert.throws(() => game.equipItem(run, 999), /not in your inventory/);
  assert.throws(() => game.unequipItem(run, 'hat'), /Unknown equipment slot/);
  assert.throws(() => game.unequipItem(run, 'weapon'), /Nothing is equipped/);

  run.hero.inventory.push({ id: 7, name: 'Rusty Dagger', icon: '🗡️', slot: 'weapon', rarity: 'common', rarityLabel: 'Common', stats: { atk: 2 }, value: 12 });
  await game.startAction(run, 'attack', SOURCE);
  assert.throws(() => game.equipItem(run, 7), /Finish the current puzzle/);
  game.answer(run, [7]);
  game.equipItem(run, 7);
  assert.strictEqual(run.hero.equipment.weapon.name, 'Rusty Dagger');

  run.phase = 'over';
  assert.throws(() => game.unequipItem(run, 'weapon'), /run is over/);
});

// ---------- Enchantments ----------
// Walk into a forced enchanter room with a chosen amount of gold and solved puzzles.
function inEnchant(gold = 0, solved = 0) {
  const run = game.createRun('u', rng);
  run.map[0][0] = { type: 'enchant' };
  game.enterRoom(run, 0);
  run.hero.gold = gold;
  run.puzzleStats.solved = solved;
  return run;
}
const testItem = (id, over = {}) => ({
  id, key: 'short_sword', name: 'Short Sword', icon: '⚔️', slot: 'weapon',
  rarity: 'common', rarityLabel: 'Common', stats: { atk: 4 }, value: 25, ...over
});

test('puzzle stats count only correct answers given before the deadline', async () => {
  const run = inFight('Slime');
  run.enemy.hp = 999;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7]);
  assert.deepStrictEqual(run.puzzleStats, { solved: 1, attempted: 1, perfectTurns: 1 });

  await game.startAction(run, 'attack', SOURCE, 1000);
  game.answer(run, [7], 1000 + 20000 + game.GRACE_MS + 1);   // too late: no credit
  assert.deepStrictEqual(run.puzzleStats, { solved: 1, attempted: 2, perfectTurns: 1 });
  assert.deepStrictEqual(game.view(run).puzzleStats, { solved: 1, attempted: 2, perfectTurns: 1 });
});

test('enchanter room opens and closes; tiers unlock from puzzles solved in time', () => {
  const run = inEnchant(1000, 0);
  assert.strictEqual(run.phase, 'enchant');
  let v = game.view(run);
  assert.strictEqual(v.room.type, 'enchant');
  assert.strictEqual(v.enchanting.tier, null);
  assert.strictEqual(v.enchanting.next.name, 'Lesser');
  assert.strictEqual(v.enchanting.options.length, Object.keys(game.ENCHANTS).length);
  assert.strictEqual(v.enchanting.options[0].cost, null);
  assert.throws(() => game.enchantItem(run, 1, 'sharp'), /Solve 3 puzzles/);

  run.puzzleStats.solved = 3;
  v = game.view(run);
  assert.strictEqual(v.enchanting.tier.name, 'Lesser');
  assert.strictEqual(v.enchanting.tier.gold, 20);
  assert.strictEqual(v.enchanting.options[0].amount, game.ENCHANTS.sharp.base);

  run.puzzleStats.solved = 8;
  assert.strictEqual(game.view(run).enchanting.tier.name, 'Greater');
  run.puzzleStats.solved = 25;
  v = game.view(run);
  assert.strictEqual(v.enchanting.tier.name, 'Mythic');
  assert.strictEqual(v.enchanting.next, null);
  assert.strictEqual(v.enchanting.options[0].amount, game.ENCHANTS.sharp.base * 4);

  game.leaveRoom(run);
  assert.strictEqual(run.phase, 'map');
  assert.strictEqual(game.view(run).enchanting, null);
});

test('enchanting equipped gear costs gold, boosts stats immediately and replaces the old enchantment', () => {
  const run = inEnchant(100, 3);
  const h = run.hero;
  const sword = testItem(201);
  h.inventory.push(sword);
  game.equipItem(run, 201);
  const atk = h.atk;

  game.enchantItem(run, 201, 'sharp');
  assert.strictEqual(h.gold, 80);
  assert.strictEqual(h.atk, atk + 2);
  assert.deepStrictEqual(sword.enchant.stats, { atk: 2 });
  assert.strictEqual(sword.enchant.tierName, 'Lesser');
  assert.ok(run.log.some(l => /Enchanted .*Lesser Sharpened/.test(l)));

  game.enchantItem(run, 201, 'vital');                       // one enchantment per item: replaces
  assert.strictEqual(h.gold, 60);
  assert.strictEqual(h.atk, atk);                            // sharp bonus is gone, not stacked
  assert.strictEqual(h.maxHp, 60 + 8);
  const v = game.view(run);
  assert.strictEqual(v.equipment.weapon.enchant.name, 'Vital');
  assert.strictEqual(v.equipment.weapon.enchant.text, '+8 HP');
});

test('enchanting a bagged item does not change stats until it is equipped', () => {
  const run = inEnchant(50, 3);
  const h = run.hero;
  const ring = testItem(301, { key: 'lucky_charm', name: 'Lucky Charm', icon: '🍀', slot: 'trinket', stats: { maxMp: 5 }, value: 18 });
  h.inventory.push(ring);
  const maxMp = h.maxMp;

  game.enchantItem(run, 301, 'arcane');
  assert.strictEqual(h.gold, 30);
  assert.strictEqual(h.maxMp, maxMp);                        // still in the bag
  assert.strictEqual(game.view(run).inventory[0].enchant.name, 'Arcane');

  game.equipItem(run, 301);
  assert.strictEqual(h.maxMp, maxMp + 5 + 4);                // gear + enchantment now apply
});

test('higher tiers scale the bonus and cost; bad requests are rejected', () => {
  const run = inEnchant(200, 8);
  const h = run.hero;
  const armor = testItem(401, { key: 'leather_armor', name: 'Leather Armor', icon: '🥋', slot: 'armor', stats: { def: 2, maxHp: 10 } });
  h.inventory.push(armor);

  game.enchantItem(run, 401, 'warded');
  assert.strictEqual(h.gold, 155);                           // Greater costs 45
  assert.deepStrictEqual(armor.enchant.stats, { def: 4 });   // base 2 x tier 2
  assert.strictEqual(armor.enchant.tierName, 'Greater');
  assert.strictEqual(h.def, 2);                              // still in the bag, so base DEF only

  assert.throws(() => game.enchantItem(run, 999, 'sharp'), /not in your equipment or bag/);
  assert.throws(() => game.enchantItem(run, 401, 'fire'), /Unknown enchantment/);

  run.phase = 'map';
  assert.throws(() => game.enchantItem(run, 401, 'sharp'), /find an enchanter/);
});

test('enchanting needs enough gold and no pending puzzle', () => {
  const run = inEnchant(10, 3);
  const h = run.hero;
  h.inventory.push(testItem(501));
  assert.throws(() => game.enchantItem(run, 501, 'sharp'), /Not enough gold/);
  h.gold = 100;
  run.pending = { n: 1 };
  assert.throws(() => game.enchantItem(run, 501, 'sharp'), /Finish the current puzzle/);
  run.pending = null;
  game.enchantItem(run, 501, 'sharp');
  assert.strictEqual(h.gold, 80);
});
// ---------- Equipment & loot ----------
test('bosses always drop from their own loot table; rarity scales the stats', async () => {
  const run = inFight('Ancient Dragon');
  run.enemy.hp = 1;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7, 7, 7]);
  assert.strictEqual(run.hero.inventory.length, 1);                 // boss drop chance is 100%
  const item = run.hero.inventory[0];
  assert.strictEqual(item.key, 'dragonscale');                      // rng 0.5 picks the middle entry
  assert.strictEqual(item.rarity, 'rare');
  assert.deepStrictEqual(item.stats, { def: 11, maxHp: 53 });       // base 6/30 * rare 1.75
  const v = game.view(run);
  assert.strictEqual(v.inventory.length, 1);
  assert.strictEqual(v.inventory[0].rarityLabel, 'Rare');
  assert.strictEqual(v.inventory[0].statText, '+11 DEF, +53 HP');
  assert.strictEqual(v.equipment.weapon, null);
  assert.ok(v.log.some(l => /Loot! .*Dragonscale/.test(l)));
});

test('mob drops are chance-based and come from that enemy, not the tier fallback', async () => {
  const lucky = () => 0;                                            // every roll succeeds, common rarity
  const run = game.createRun('u', lucky);
  const i = run.map[0].findIndex(d => d.type === 'combat');
  run.map[0][i] = { type: 'combat', enemy: 'Slime' };
  game.enterRoom(run, i);
  run.enemy.hp = 1;
  await game.startAction(run, 'attack', SOURCE);
  game.answer(run, [7]);
  assert.strictEqual(run.hero.inventory.length, 1);
  assert.strictEqual(run.hero.inventory[0].key, 'cloth_vest');      // Slime's own table
  assert.strictEqual(run.hero.inventory[0].rarity, 'common');

  const unlucky = inFight('Slime');                                 // rng 0.5 > 35% drop chance
  unlucky.enemy.hp = 1;
  await game.startAction(unlucky, 'attack', SOURCE);
  game.answer(unlucky, [7]);
  assert.strictEqual(unlucky.hero.inventory.length, 0);
});

test('equipping gear adds stats, swapping stows the old item, unequipping removes the bonus', () => {
  const run = inFight('Slime');
  const h = run.hero;
  h.inventory.push(
    { id: 101, key: 'short_sword', name: 'Short Sword', icon: '⚔️', slot: 'weapon', rarity: 'common', rarityLabel: 'Common', stats: { atk: 4 }, value: 25 },
    { id: 102, key: 'iron_axe', name: 'Iron Axe', icon: '🪓', slot: 'weapon', rarity: 'rare', rarityLabel: 'Rare', stats: { atk: 12 }, value: 79 },
    { id: 103, key: 'leather_armor', name: 'Leather Armor', icon: '🥋', slot: 'armor', rarity: 'common', rarityLabel: 'Common', stats: { def: 2, maxHp: 10 }, value: 30 }
  );
  const atk = h.atk, def = h.def, maxHp = h.maxHp, hp = h.hp;

  game.equipItem(run, 101);
  assert.strictEqual(h.equipment.weapon.name, 'Short Sword');
  assert.strictEqual(h.atk, atk + 4);
  assert.strictEqual(h.inventory.length, 2);

  game.equipItem(run, 102);                                         // swap the slot
  assert.strictEqual(h.equipment.weapon.name, 'Iron Axe');
  assert.strictEqual(h.atk, atk + 12);                              // not atk + 4 + 12
  assert.ok(h.inventory.some(i => i.name === 'Short Sword'));

  game.equipItem(run, 103);                                         // armor also raises the cap and current HP
  assert.strictEqual(h.maxHp, maxHp + 10);
  assert.strictEqual(h.hp, hp + 10);
  assert.strictEqual(h.def, def + 2);

  game.unequipItem(run, 'weapon');
  assert.strictEqual(h.equipment.weapon, null);
  assert.strictEqual(h.atk, atk);
  game.unequipItem(run, 'armor');
  assert.strictEqual(h.maxHp, maxHp);
  assert.strictEqual(h.hp, hp);                                     // clamped back down
  assert.strictEqual(h.def, def);
  assert.strictEqual(h.inventory.length, 3);

  const v = game.view(run);
  assert.deepStrictEqual(v.hero.bonus, { atk: 0, def: 0, maxHp: 0, maxMp: 0 });
  assert.strictEqual(v.inventory.length, 3);
});

test('equipment changes are rejected for bad ids/slots and while a puzzle is pending', async () => {
  const run = inFight('Slime');
  assert.throws(() => game.equipItem(run, 999), /not in your inventory/);
  assert.throws(() => game.unequipItem(run, 'hat'), /Unknown equipment slot/);
  assert.throws(() => game.unequipItem(run, 'weapon'), /Nothing is equipped/);

  run.hero.inventory.push({ id: 7, name: 'Rusty Dagger', icon: '🗡️', slot: 'weapon', rarity: 'common', rarityLabel: 'Common', stats: { atk: 2 }, value: 12 });
  await game.startAction(run, 'attack', SOURCE);
  assert.throws(() => game.equipItem(run, 7), /Finish the current puzzle/);
  game.answer(run, [7]);
  game.equipItem(run, 7);
  assert.strictEqual(run.hero.equipment.weapon.name, 'Rusty Dagger');

  run.phase = 'over';
  assert.throws(() => game.unequipItem(run, 'weapon'), /run is over/);
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

// Over HTTP: pick the first door that leads to a fight (the API only exposes door types, like the real UI).
async function enterFight() {
  const run = (await call('/api/run')).body.run;
  const i = run.map.doors.findIndex(d => d.type === 'combat');
  return call('/api/run/door', 'POST', { choice: i });
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
  const sess = await call('/api/session');
  assert.strictEqual(sess.status, 200);
  assert.strictEqual(sess.body.username, null);
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
  const fresh = await call('/api/run/new', 'POST');
  assert.strictEqual(fresh.status, 200);
  assert.strictEqual(fresh.body.run.phase, 'map');                                                   // starts at the door choice
  assert.strictEqual(fresh.body.run.map.doors.length, 2);
  assert.strictEqual((await call('/api/run/action', 'POST', { action: 'attack' })).status, 400);    // not in combat yet
  assert.strictEqual((await call('/api/run/door', 'POST', { choice: 9 })).status, 400);             // no such door
  assert.strictEqual((await call('/api/run/leave', 'POST')).status, 400);                           // nothing to leave
  const entered = await enterFight();
  assert.strictEqual(entered.status, 200);
  assert.strictEqual(entered.body.run.phase, 'combat');
  assert.ok(entered.body.run.enemy.name);
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
  await call('/api/run/new', 'POST');
  await enterFight();
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
  await enterFight();
  for (let i = 0; i < 80; i++) {                         // answer wrong on purpose until the hero dies
    const a = await call('/api/run/action', 'POST', { action: 'attack' });
    if (a.status !== 200) break;
    const r = await call('/api/run/answer', 'POST', { answers: a.body.puzzles.map(() => 0) });
    if (r.body.run.phase === 'over') break;
  }
  const lb = (await call('/api/leaderboard')).body;
  assert.ok(lb.some(r => r.username === 'hero2'));
  const me = (await call('/api/me')).body;
  assert.strictEqual(me.runs, 1);
  await call('/api/logout', 'POST');
  assert.strictEqual((await call('/api/me')).status, 401);
});

test('http: profile exposes history and stats without the password; avatar changes are validated', async () => {
  assert.strictEqual((await call('/api/login', 'POST', { username: 'hero2', password: 'secret2' })).status, 200);
  const p = await call('/api/profile');
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.username, 'hero2');
  assert.ok(Array.isArray(p.body.history));
  assert.ok(p.body.history.length >= 1);                         // the previous test recorded a run
  assert.strictEqual(p.body.history[0].score, 10);               // died in the first room: 0*100 + 0 gold + level 1*10
  assert.ok(p.body.avatars.includes(p.body.avatar));
  assert.ok(!JSON.stringify(p.body).includes('password'));
  assert.ok(!JSON.stringify(p.body).includes('hash'));

  assert.strictEqual((await call('/api/profile/avatar', 'POST', { avatar: '🍌' })).status, 200);
  assert.strictEqual((await call('/api/me')).body.avatar, '🍌');
  assert.strictEqual((await call('/api/profile/avatar', 'POST', { avatar: '<script>' })).status, 400);

  const lb = (await call('/api/leaderboard')).body;
  assert.ok(lb.length >= 1);
  assert.strictEqual(lb[0].rank, 1);
  assert.ok(lb[0].avatar);
  assert.ok('bestFloor' in lb[0] && 'runs' in lb[0]);
});

test('http: run view exposes equipment and the equip/unequip routes validate input', async () => {
  const fresh = await call('/api/run/new', 'POST');
  assert.strictEqual(fresh.status, 200);
  const v = fresh.body.run;
  assert.deepStrictEqual(Object.keys(v.equipment).sort(), ['armor', 'trinket', 'weapon']);
  assert.deepStrictEqual(v.inventory, []);
  assert.deepStrictEqual(v.hero.bonus, { atk: 0, def: 0, maxHp: 0, maxMp: 0 });
  assert.deepStrictEqual(v.puzzleStats, { solved: 0, attempted: 0, perfectTurns: 0 });
  assert.strictEqual(v.enchanting, null);
  assert.strictEqual((await call('/api/run/equip', 'POST', { itemId: 999 })).status, 400);
  assert.strictEqual((await call('/api/run/equip', 'POST', {})).status, 400);
  assert.strictEqual((await call('/api/run/unequip', 'POST', { slot: 'weapon' })).status, 400);
  assert.strictEqual((await call('/api/run/unequip', 'POST', { slot: 'hat' })).status, 400);
});

test('http: enchanter room is exposed and the enchant route validates state', async () => {
  await call('/api/run/new', 'POST');
  assert.strictEqual((await call('/api/run/enchant', 'POST', { itemId: 1, enchantKey: 'sharp' })).status, 400);

  // Enchanter doors are random, so start runs until one is offered.
  let entered = null;
  for (let attempt = 0; attempt < 50 && !entered; attempt++) {
    await call('/api/run/new', 'POST');
    const run = (await call('/api/run')).body.run;
    const idx = run.map.doors.findIndex(d => d.type === 'enchant');
    if (idx >= 0) entered = await call('/api/run/door', 'POST', { choice: idx });
  }
  assert.ok(entered, 'an enchanter door should eventually be generated');
  assert.strictEqual(entered.body.run.phase, 'enchant');
  assert.strictEqual(entered.body.run.room.type, 'enchant');
  assert.strictEqual(entered.body.run.enchanting.tier, null);
  assert.strictEqual(entered.body.run.enchanting.options.length, 4);

  assert.strictEqual((await call('/api/run/enchant', 'POST', { itemId: 1, enchantKey: 'sharp' })).status, 400);
  assert.strictEqual((await call('/api/run/enchant', 'POST', { itemId: 1, enchantKey: 'fire' })).status, 400);
  assert.strictEqual((await call('/api/run/leave', 'POST')).status, 200);
});
