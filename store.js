// store.js - tiny JSON-file persistence for user accounts, profiles and scores (MVP). Own code.
// Final product: replace with SQLite (see PLAN.md) because this is not safe for concurrent writers.
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DIR, 'users.json');
const MAX_HISTORY = 10;
const DEFAULT_AVATAR = '🧙';

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}

function save(users) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, FILE);                       // atomic replace: no half-written file on crash
}

// Old accounts predate avatars / history / lifetime totals. Fill gaps on read so the
// upgrade needs no migration script and no downtime.
function normalize(u) {
  if (!u || typeof u !== 'object') return u;
  if (typeof u.avatar !== 'string' || !u.avatar) u.avatar = DEFAULT_AVATAR;
  if (!u.createdAt) u.createdAt = new Date().toISOString();
  if (!Number.isFinite(u.totalGold)) u.totalGold = 0;
  if (!Number.isFinite(u.totalKills)) u.totalKills = 0;
  if (!Array.isArray(u.history)) u.history = [];
  return u;
}

function freshUser(name, passwordRecord) {
  return {
    username: name,
    password: passwordRecord,
    avatar: DEFAULT_AVATAR,
    createdAt: new Date().toISOString(),
    bestScore: 0,
    bestFloor: 0,
    wins: 0,
    runs: 0,
    totalGold: 0,
    totalKills: 0,
    history: []
  };
}

function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = normalize(u);
  return { ...rest, history: rest.history.slice(0, MAX_HISTORY) };
}

const byRank = (a, b) =>
  b.bestScore - a.bestScore || b.wins - a.wins || b.bestFloor - a.bestFloor || a.username.localeCompare(b.username);

function rankedUsers(users) {
  return Object.values(users)
    .map(normalize)
    .filter(u => u.runs > 0)
    .sort(byRank);
}

module.exports = {
  MAX_HISTORY,
  DEFAULT_AVATAR,

  getUser(name) { return normalize(load()[name.toLowerCase()] || null); },

  // Browser-safe copy: never includes the password hash.
  getPublic(name) { return publicUser(load()[name.toLowerCase()]); },

  createUser(name, passwordRecord) {
    const users = load();
    const key = name.toLowerCase();
    if (users[key]) return false;
    users[key] = freshUser(name, passwordRecord);
    save(users);
    return true;
  },

  setAvatar(name, avatar) {
    const users = load();
    const u = users[name.toLowerCase()];
    if (!u) return null;
    normalize(u).avatar = avatar;
    save(users);
    return publicUser(u);
  },

  recordRun(name, result) {
    const users = load();
    const u = users[name.toLowerCase()];
    if (!u) return null;
    normalize(u);
    const entry = {
      at: new Date().toISOString(),
      score: Number(result.score) || 0,
      won: !!result.won,
      cleared: Number(result.cleared) || 0,
      floor: Number(result.floor) || 0,
      gold: Number(result.gold) || 0,
      level: Number(result.level) || 1,
      durationMs: Number(result.durationMs) || 0
    };
    u.runs++;
    if (entry.won) u.wins++;
    u.bestScore = Math.max(u.bestScore, entry.score);
    u.bestFloor = Math.max(u.bestFloor, entry.cleared);
    u.totalGold += entry.gold;
    u.totalKills += entry.cleared;
    u.history.unshift(entry);
    u.history = u.history.slice(0, MAX_HISTORY);
    save(users);
    return publicUser(u);
  },

  // 1-based position on the all-time board, or null for a player with no finished runs.
  rankOf(name) {
    const i = rankedUsers(load()).findIndex(u => u.username.toLowerCase() === name.toLowerCase());
    return i === -1 ? null : i + 1;
  },

  leaderboard(limit = 10) {
    return rankedUsers(load())
      .slice(0, limit)
      .map((u, i) => ({
        rank: i + 1,
        username: u.username,
        avatar: u.avatar,
        bestScore: u.bestScore,
        wins: u.wins,
        bestFloor: u.bestFloor,
        runs: u.runs
      }));
  }
};
