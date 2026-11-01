# Plan for the final product

Submission: **4 Dec 2026, 10:00** (video = 60% of the unit). Today is 29 Oct 2026, so about 5 weeks remain.
Hard requirements from the brief: present to your tutor **by Week 8** (otherwise the grade is capped at 58),
submit the code as a dedicated upload, speak the video in **your own voice** (no AI for the video),
reference all LLM/borrowed code, and make the code complex enough for 10 minutes of discussion.

## 1. What the MVP already covers

Dungeon with 3 floors and door-choice rooms (monster, treasure, campfire, merchant), floor bosses, Banana puzzles gating
attack/skill/heal, mob/mid-boss/boss tiers, login with cookies, leaderboard, 21 tests. The gaps below are what move each theme from "describes it" to 70%+ ("critically evaluates alternatives").

## 2. Improvements per theme (aim for these in the video)

| Theme | Add to the code | Evaluate / compare in the video |
| --- | --- | --- |
| Version control | Real Git history: `main` + feature branches, small commits, tags (`v0.2-mvp`, `v1.0`), a merge or two | Commit granularity, branching strategy, how the module split reduces merge conflicts, Git vs SVN vs none |
| Events | Server-sent events (live "player X beat the dragon" feed); a turn queue for enemy status effects (poison, stun) | Event-driven vs polling vs a game loop; observer pattern (`EventEmitter`) and its trade-offs |
| Interoperability | Cache/fallback puzzles when Banana is down; try `out=csv` / `base64=yes`; document your own API (OpenAPI-style table) | REST+JSON vs CSV vs SOAP; why proxy through the server; failure handling; reliance on a third party |
| Virtual identity | Persist sessions in the DB; CSRF token; role (admin); `Secure` cookie via HTTPS; per-IP rate limit | Sessions vs JWT vs OAuth ("Sign in with Google") vs passkeys; threats (XSS, CSRF, brute force, enumeration) |

## 3. Gameplay features to add (complexity for the video, in priority order)

0. More dungeons: `DUNGEON` in `game.js` is plain data, so a second dungeon (different floors, monsters) is mostly data plus a dungeon-select screen.
1. Hero classes (Warrior / Mage / Rogue) with different stats and skills, chosen at run start.
2. Status effects (poison, stun, shield) and more enemy move types.
3. More floors, random encounter order, a hard-mode with harder tiers (more puzzles, shorter timers).
4. Persistent progression: unlocks and gold carried between runs (stored per user).
5. Replace `store.js` with SQLite; store runs so a refresh or restart resumes the game.
6. Polish: sound/animation on hit, mobile layout check, accessibility (keyboard already works).

## 4. Timeline

| When | Goal |
| --- | --- |
| Now (wk 3-4) | Run the MVP, read every file, push to GitHub with real commits; start classes + status effects |
| Wk 5 | Auth hardening (CSRF, rate limits), SQLite storage |
| Wk 6-7 | SSE live feed, Banana fallback cache, more tests |
| **Wk 8** | **Present to tutor** and keep evidence (email / screenshot); collect feedback |
| Wk 9 | Apply feedback, feature freeze, tag `v1.0` |
| Wk 10 | Rehearse once, then record the video (minimal editing) |
| Wk 11 | Upload code + video before **4 Dec 10:00** |

## 5. Git workflow to use (and talk about)

- `main` always runs and passes `npm test`. Work on `feature/<name>` branches (`feature/classes`, `feature/sqlite`).
- One logical change per commit, imperative messages ("Add stun status effect").
- Tag milestones; `.gitignore` already excludes `data/` and `node_modules/`.
- Review your own diff before merging; mention this as your "code review" practice.

## 6. Video outline (max 10 minutes, your voice, start with a demo)

| Time | Content |
| --- | --- |
| 0:00-1:00 | Live demo: register, fight a mob, a boss turn with 3 puzzles, a heavy-attack warning, level-up |
| 1:00-3:00 | Version control: repo, branch graph, commit history, module boundaries, alternatives |
| 3:00-5:30 | Events: click/keydown/timer in `app.js`, HTTP handlers, `EventEmitter` in `game.js`, one turn traced end to end |
| 5:30-8:00 | Interoperability: `banana.js`, JSON shape, validation, why the server proxies, outage behaviour, alternatives |
| 8:00-10:00 | Virtual identity: hashing, cookie flags, expiry, lockout, CSP; compare with JWT/OAuth and weaknesses |

## 7. Submission checklist

- [ ] Presented to tutor by Week 8 (keep proof)
- [ ] Code uploaded as its own submission (not only visible in the video)
- [ ] LLM help and any borrowed code referenced in README **and** file comments
- [ ] Video: own voice, demo first, all four themes tied to your code, little editing, under 10 minutes
- [ ] `npm test` passes; screenshots of tests saved as optional evidence
