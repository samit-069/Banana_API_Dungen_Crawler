// store.js - tiny JSON-file persistence for user accounts and scores (MVP). Own code.
// Final product: replace with SQLite (see PLAN.md) because this is not safe for concurrent writers.
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DIR, 'users.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}

function save(users) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, FILE);                       // atomic replace: no half-written file on crash
}

module.exports = {
  getUser(name) { return load()[name.toLowerCase()] || null; },

  createUser(name, passwordRecord) {
    const users = load();
    const key = name.toLowerCase();
    if (users[key]) return false;
    users[key] = { username: name, password: passwordRecord, bestScore: 0, bestFloor: 0, wins: 0, runs: 0 };
    save(users);
    return true;
  },

  recordRun(name, { score, cleared, won }) {
    const users = load();
    const u = users[name.toLowerCase()];
    if (!u) return null;
    u.runs++;
    if (won) u.wins++;
    u.bestScore = Math.max(u.bestScore, score);
    u.bestFloor = Math.max(u.bestFloor, cleared);
    save(users);
    return u;
  },

  leaderboard(limit = 5) {
    return Object.values(load())
      .filter(u => u.runs > 0)
      .map(u => ({ username: u.username, bestScore: u.bestScore, wins: u.wins }))
      .sort((a, b) => b.bestScore - a.bestScore)
      .slice(0, limit);
  }
};
