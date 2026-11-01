# Banana Quest (CIS046-3)

A turn-based dungeon RPG. Every attack, skill and heal is powered by a puzzle from the third-party
**Banana API** (`https://marcconrad.com/uob/banana/api.php`, by Marc Conrad). The API returns a puzzle
image plus its solution (one digit, 0-9). The server keeps the solution secret and checks your answers.

## Run it

Needs **Node.js 18+** only. There are **no npm dependencies**, so no `npm install` and no virtual environment.

```bash
node server.js      # or: npm start      -> http://localhost:3000
npm test            # 27 tests, uses a fake Banana API, works offline
```

Optional env vars: `PORT` (3000), `BANANA_API` (override API URL), `DATA_DIR` (where users.json is stored).

## How to play

Register, then start an adventure in **The Banana Crypt**: 3 floors, each made of 3 rooms plus a floor boss.
Between rooms you choose one of two doors. A fight is always on offer; the other door may be another fight,
💰 treasure, 🔥 a campfire (heals you) or 🛒 a merchant (buys potions). Doors show what is behind them, so you
decide when to fight for XP and when to heal. Floor 1 ends with a mid-boss, floor 2 with a mid-boss, floor 3 with the dragon.
Each combat turn you pick an action; puzzle actions show Banana puzzle images and a countdown.
Keyboard: 1/2 choose a door, Enter continues.

**Screens.** After logging in you land on the **dashboard**: avatar, title, six career stats (best score, wins,
runs, rooms cleared, lifetime gold, global rank), your last four runs and a top-five leaderboard. The
**leaderboard** page ranks all players by best score (ties broken by wins, then rooms cleared). The **profile**
page shows your career stats, full run history (score, floor, gold, duration) and an avatar picker. Both the
dashboard and profile are built from the same `/api/me` / `/api/profile` payload, so the server stays the only
source of truth. An unfinished run is offered as **Continue adventure** rather than being silently replaced.

| Action | Cost | Effect |
| --- | --- | --- |
| Attack | puzzles | Damage = ATK x (correct / total puzzles) |
| Power Strike | 8 MP, +1 puzzle | 2.2x damage |
| Heal | 6 MP, 1 puzzle | Restore 35% max HP (all-or-nothing) |
| Defend | none | Halves the next hit, +4 MP |
| Potion | none | +40 HP (buy more between fights) |

**Difficulty scaling.** The Banana API has no difficulty setting (every puzzle is a single digit), so tiers differ in
*how many puzzles per action* and *how much time you get*:

| Tier | Puzzles per attack | Time per puzzle |
| --- | --- | --- |
| Mob | 1 | 20 s |
| Mid-boss | 2 | 15 s |
| Boss | 3 | 12 s |

Other mechanics: partial credit (2 of 3 correct = 2/3 damage), combo bonus (+10% per consecutive perfect turn, max +50%),
bosses telegraph a **heavy attack every 3rd turn** (warning shown, so Defend), XP/levels, gold, a small heal when you descend a floor.
Keyboard: A/S/H/D/P pick actions, 0-9 answer puzzles, Enter submits, B toggles the bag.

**Loot & equipment.** Defeated enemies can drop gear: mobs 35%, mid-bosses 75%, bosses 100%. Each enemy has its
own loot table, and the drop rolls a rarity (**common / uncommon / rare / epic**) that scales its stats. Gear fills
three slots — **weapon**, **armor**, **trinket** — and is managed from the 🎒 **Bag** panel on the battle screen
(or the B key). Equipping recalculates ATK/DEF/max HP/max MP from your base stats plus gear, so swapping never
double-counts; equipping armour also grants the extra HP immediately. Equipment belongs to the current run and is
reset with a new adventure.

## Files

| File | Role |
| --- | --- |
| `game.js` | RPG engine: dungeon/floor/room generation, combat, loot/equipment rules, bestiary data. No I/O, emits events, fully unit-tested |
| `banana.js` | Client for the Banana API (the interoperability layer) |
| `server.js` | HTTP server (Node built-ins only): routes, auth, sessions, static files |
| `store.js` | JSON-file user profiles, run history and score storage (MVP) |
| `public/` | Browser UI (`index.html`, `app.js`, `style.css`) |
| `test.js` | Engine unit tests + HTTP integration tests |

## HTTP API

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/register` / `POST /api/login` | no | Create an account / start a session cookie |
| `POST /api/logout` | yes | Delete the session and expire the cookie |
| `GET /api/session` | no | Cheap probe: `{ username }` or `{ username: null }` for the page-load handler |
| `GET /api/me` / `GET /api/profile` | yes | Profile, career stats, rank and last 10 runs (no password hash) |
| `POST /api/profile/avatar` | yes | Choose an avatar from the server-side allow-list |
| `GET /api/leaderboard` | no | Top 10 players with rank, avatar, score, wins, rooms, runs |
| `GET /api/run` / `POST /api/run/new` | yes | Read the current run / start a fresh one |
| `POST /api/run/action` | yes | Pick a combat action; returns puzzle images (never solutions) |
| `POST /api/run/answer` | yes | Submit digits; the server checks answers and the deadline |
| `POST /api/run/door` / `POST /api/run/leave` | yes | Navigate the dungeon / leave a cleared room or shop |
| `POST /api/run/shop` | yes | Buy a potion from the merchant |
| `POST /api/run/equip` | yes | Equip `{ itemId }` from the bag (swaps the slot back into the bag) |
| `POST /api/run/unequip` | yes | Unequip `{ slot }` (`weapon` / `armor` / `trinket`) |

## The four video themes in this code

- **Version control**: separated modules (`game.js` / `banana.js` / `server.js` / `store.js` / UI) so each Git commit and branch touches one concern. See PLAN.md.
- **Event-driven programming**: browser (`click`, `keydown`, `submit`, `load`, 250 ms timer tick, auto-submit on timeout); server (one handler per HTTP request, a cleanup timer); engine (`EventEmitter`: `heroHit`, `enemyHit`, `levelUp`, `runOver`... the combat log and score saving are listeners).
- **Interoperability**: `banana.js` is an HTTPS + JSON client for a service we do not control. Responses are validated, one retry, 6 s timeout, an outage returns 502 and costs the player nothing. The server proxies so the solution never reaches the browser.
- **Virtual identity**: scrypt salted password hashes; 256-bit random session id in an `HttpOnly; SameSite=Strict` cookie; 1 h expiry; same error for unknown user or bad password; lockout after 5 failures; Content-Security-Policy header.

## Code provenance (the brief requires this)

- Game design, engine, UI and tests were written for this assignment **with the help of an LLM (Claude)**. Add your own
  edits and understanding; mark in the file headers which parts you changed or wrote yourself.
- Third-party service: Banana API (Marc Conrad, University of Bedfordshire). No third-party code or packages are used.
- If you copy anything else (forum answers, classmates, other tools), list it here and in a comment at the point of use.

## Known limitations (good material for "critical evaluation")

- Sessions and runs are in memory (lost on restart); users stored in a JSON file (not concurrency-safe).
- Equipment and inventory live on the run, not the account: a new adventure starts with an empty bag. Account-wide
  gear storage (a persistent stash) is a natural next step.
- No HTTPS, so the cookie has no `Secure` flag in local development.
- Players could in principle solve puzzles with an external tool; the timer limits but cannot prevent this.
- Lockout counters are per username (an attacker can lock a victim out); a real system would also use IP limits.
