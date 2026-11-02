# Banana Quest (CIS046-3)

A turn-based dungeon RPG. Every attack, skill and heal is powered by a puzzle from the third-party
**Banana API** (`https://marcconrad.com/uob/banana/api.php`, by Marc Conrad). The API returns a puzzle
image plus its solution (one digit, 0-9). The server keeps the solution secret and checks your answers.

## Run it

Needs **Node.js 18+** only. There are **no npm dependencies**, so no `npm install` and no virtual environment.

```bash
node server.js      # or: npm start      -> http://localhost:3000
npm test            # 21 tests, uses a fake Banana API, works offline
```

Optional env vars: `PORT` (3000), `BANANA_API` (override API URL), `DATA_DIR` (where users.json is stored).

## How to play

Register, then start an adventure in **The Banana Crypt**: 3 floors, each made of 3 rooms plus a floor boss.
Between rooms you choose one of two doors. A fight is always on offer; the other door may be another fight,
💰 treasure, 🔥 a campfire (heals you) or 🛒 a merchant (buys potions). Doors show what is behind them, so you
decide when to fight for XP and when to heal. Floor 1 ends with a mid-boss, floor 2 with a mid-boss, floor 3 with the dragon.
Each combat turn you pick an action; puzzle actions show Banana puzzle images and a countdown.
Keyboard: 1/2 choose a door, Enter continues.

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
Keyboard: A/S/H/D/P pick actions, 0-9 answer puzzles, Enter submits.

## Files

| File | Role |
| --- | --- |
| `game.js` | RPG engine: dungeon/floor/room generation, combat rules, bestiary data. No I/O, emits events, fully unit-tested |
| `banana.js` | Client for the Banana API (the interoperability layer) |
| `server.js` | HTTP server (Node built-ins only): routes, auth, sessions, static files |
| `store.js` | JSON-file user + score storage (MVP) |
| `public/` | Browser UI (`index.html`, `app.js`, `style.css`) |
| `test.js` | Engine unit tests + HTTP integration tests |

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
- No HTTPS, so the cookie has no `Secure` flag in local development.
- Players could in principle solve puzzles with an external tool; the timer limits but cannot prevent this.
- Lockout counters are per username (an attacker can lock a victim out); a real system would also use IP limits.
