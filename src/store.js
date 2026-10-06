// Tiny JSON-file store. One bot process is the only writer, so this is plenty.
// data/store.json holds live state; data/draft-history.json holds /sgdraft history.
// Shape:
// {
//   guilds: {
//     "<guildId>": {
//       announceChannelId: "…" | null,
//       players: {
//         "<discordUserId>": {
//           steamId, name, registeredAt,
//           seen: [recordId, …],   // recently-seen record ids (bounded)
//           primed: boolean        // false until we've captured their existing history
//         }
//       }
//     }
//   }
// }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(dir, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const SEEN_LIMIT = 100;

let state = { guilds: {} };

// Tournament history for /sgdraft lives in its own file: it is kept forever and
// only grows, so it shouldn't be rewritten on every announcer tick with the rest.
// Shape: { guilds: { "<guildId>": { nextId, tournaments: [ … ] } } }
const HISTORY_FILE = path.join(DATA_DIR, 'draft-history.json');
let history = { guilds: {} };

// Counting rounds are a permanent record of who won real money, so they get the
// same treatment: their own file, never rewritten by anything else.
const COUNT_FILE = path.join(DATA_DIR, 'count-history.json');
let countHistory = { guilds: {} };

/**
 * Read a JSON file. Missing → null. Unreadable → the file is moved aside (never
 * overwritten) and null is returned; if it can't even be moved, refuse to start.
 */
function readJson(file) {
  const name = `data/${path.basename(file)}`;
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch (err) {
    // Starting fresh would be quietly catastrophic: the first write then
    // overwrites the real file and its contents are gone for good. Keep the
    // unreadable file so nothing is destroyed and it can be repaired by hand.
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(file, backup);
      console.error(`⚠️  Could not read ${name} (${err.message}).`);
      console.error(`   The existing file was preserved as ${backup} — starting with empty state.`);
    } catch (moveErr) {
      console.error(`❌ ${name} is unreadable (${err.message}) and could not be`);
      console.error(`   moved aside (${moveErr.message}). Refusing to start rather than overwrite it.`);
      process.exit(1);
    }
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic replace
}

export function load() {
  state = readJson(DATA_FILE) || { guilds: {} };
  if (!state.guilds) state.guilds = {};
  history = readJson(HISTORY_FILE) || { guilds: {} };
  if (!history.guilds) history.guilds = {};
  countHistory = readJson(COUNT_FILE) || { guilds: {} };
  if (!countHistory.guilds) countHistory.guilds = {};
  for (const h of Object.values(countHistory.guilds)) {
    h.nextId = Math.max(h.nextId || 1, ...h.rounds.map((r) => r.id + 1));
  }

  // Tournament numbers must never be reused — even if the history file was
  // restored from an old backup while lobbies still point at newer numbers.
  for (const h of Object.values(history.guilds)) {
    h.nextId = Math.max(h.nextId || 1, ...h.tournaments.map((t) => t.id + 1));
  }
  const lobbies = state.draftLobbies || {};
  for (const lobby of Object.values(lobbies)) {
    if (lobby.historyId == null) continue;
    // A lobby from an older version may not know its server: bump them all.
    const guilds = lobby.guildId ? [getDraftHistory(lobby.guildId)] : Object.values(history.guilds);
    for (const h of guilds) h.nextId = Math.max(h.nextId, lobby.historyId + 1);
  }

  // An "in progress" record that no open lobby points at can never finish (the
  // process died between the two file writes): close it the way endRecord would.
  let changed = false;
  for (const h of Object.values(history.guilds)) {
    const kept = [];
    for (const t of h.tournaments) {
      const lobby = lobbies[t.lobbyMessageId];
      if (t.status === 'in_progress' && !(lobby && lobby.historyId === t.id)) {
        changed = true;
        if (!t.matches.length) continue; // nothing was played: drop it
        t.status = 'cancelled';
        t.endedAt = t.endedAt || new Date().toISOString();
      }
      kept.push(t);
    }
    h.tournaments = kept;
  }
  if (changed) writeJson(HISTORY_FILE, history);
}

export function persist() {
  writeJson(DATA_FILE, state);
}

/** One server's tournament history: { nextId, tournaments: [oldest … newest] }. */
export function getDraftHistory(guildId) {
  if (!history.guilds[guildId]) history.guilds[guildId] = { nextId: 1, tournaments: [] };
  return history.guilds[guildId];
}

export function persistDraftHistory() {
  writeJson(HISTORY_FILE, history);
}

function guild(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = { announceChannelId: null, players: {} };
  }
  return state.guilds[guildId];
}

export function allGuilds() {
  return state.guilds;
}

export function getGuild(guildId) {
  return state.guilds[guildId] || null;
}

export function getPlayers(guildId) {
  return guild(guildId).players;
}

export function findByDiscord(guildId, discordId) {
  return guild(guildId).players[discordId] || null;
}

export function isSteamTaken(guildId, steamId, exceptDiscordId) {
  return Object.entries(guild(guildId).players).some(
    ([id, p]) => p.steamId === steamId && id !== exceptDiscordId,
  );
}

export function setAnnounceChannel(guildId, channelId) {
  guild(guildId).announceChannelId = channelId;
  persist();
}

export function setLeaderboard(guildId, channelId, messageId) {
  guild(guildId).leaderboard = { channelId, messageId };
  persist();
}

export function getRankRoles(guildId) {
  const g = guild(guildId);
  if (!g.rankRoles) g.rankRoles = {};
  return g.rankRoles;
}

export function setRankRole(guildId, rankName, roleId) {
  const roles = getRankRoles(guildId);
  roles[rankName] = roleId;
  persist();
}

export function getBounties(guildId) {
  const g = guild(guildId);
  if (!g.bounties) g.bounties = [];
  return g.bounties;
}

export function addBounty(guildId, bounty) {
  getBounties(guildId).push(bounty);
  persist();
}

export function removeBounty(guildId, id) {
  const g = guild(guildId);
  const before = (g.bounties || []).length;
  g.bounties = (g.bounties || []).filter((b) => b.id !== id);
  persist();
  return g.bounties.length < before;
}

// --- Birthdays: guild.birthdays = { discordId: { day, month, year|null } } ---

export function getBirthdays(guildId) {
  const g = guild(guildId);
  if (!g.birthdays) g.birthdays = {};
  return g.birthdays;
}

export function setBirthday(guildId, discordId, birthday) {
  getBirthdays(guildId)[discordId] = birthday;
  persist();
}

export function removeBirthday(guildId, discordId) {
  const birthdays = getBirthdays(guildId);
  const existed = Boolean(birthdays[discordId]);
  delete birthdays[discordId];
  persist();
  return existed;
}

export function setBirthdayChannel(guildId, channelId) {
  guild(guildId).birthdayChannelId = channelId;
  persist();
}

/**
 * Who has been greeted today (local date), so a restart never double-posts and
 * someone added later the same day still gets their message.
 */
export function setBirthdayPosted(guildId, date, ids) {
  guild(guildId).birthdayPosted = { date, ids };
  persist();
}

/** Old per-day marker, still read on the day of the upgrade. */
export function setBirthdayLastRun(guildId, date) {
  guild(guildId).birthdayLastRun = date;
  persist();
}

// --- Contacts: guild.contacts = { ig: { discordId: handle }, phone: { … } } ---

export function getContacts(guildId, kind) {
  const g = guild(guildId);
  if (!g.contacts) g.contacts = {};
  if (!g.contacts[kind]) g.contacts[kind] = {};
  return g.contacts[kind];
}

export function setContact(guildId, kind, discordId, value) {
  getContacts(guildId, kind)[discordId] = value;
  persist();
}

export function removeContact(guildId, kind, discordId) {
  const all = getContacts(guildId, kind);
  const existed = Boolean(all[discordId]);
  delete all[discordId];
  persist();
  return existed;
}

// --- Reminders: guild.alarms = [{ id, userId, channelId, at, message, repeat }] ---

export function getAlarms(guildId) {
  const g = guild(guildId);
  if (!g.alarms) g.alarms = [];
  return g.alarms;
}

export function setAlarms(guildId, alarms) {
  guild(guildId).alarms = alarms;
  persist();
}

// --- Counting draws: guild.counting holds the open round; finished rounds and
// their winners are kept forever in data/count-history.json ---

export function getCounting(guildId) {
  return guild(guildId).counting || null;
}

export function setCounting(guildId, round) {
  const g = guild(guildId);
  if (round) g.counting = round;
  else delete g.counting;
  persist();
}

/** One server's finished rounds: { nextId, rounds: [oldest … newest] }. */
export function getCountHistory(guildId) {
  if (!countHistory.guilds[guildId]) countHistory.guilds[guildId] = { nextId: 1, rounds: [] };
  return countHistory.guilds[guildId];
}

export function persistCountHistory() {
  writeJson(COUNT_FILE, countHistory);
}

// --- Profile cards: guild.cards = { "<discordId>": { owned, equipped, seeds, … } } ---

export function getCardProfiles(guildId) {
  const g = guild(guildId);
  if (!g.cards) g.cards = {};
  return g.cards;
}

/**
 * One member's card collection, created on first touch. Everyone starts owning
 * the starter background, so a card can always be drawn.
 */
export function getCardProfile(guildId, discordId, starter = 'midnight') {
  const all = getCardProfiles(guildId);
  if (!all[discordId]) {
    all[discordId] = {
      owned: { [starter]: 1 },
      equipped: starter,
      seeds: 0,
      cases: 0,
      opened: 0,
      lastDaily: null,
      streak: 0,
      dropDate: null,
      dropCount: 0,
    };
  }
  const p = all[discordId];
  if (!p.owned) p.owned = { [starter]: 1 };
  return p;
}

/** Open /sgdraft lobbies, keyed by lobby message id. Kept until the host closes them. */
export function getDraftLobbies() {
  if (!state.draftLobbies) state.draftLobbies = {};
  return state.draftLobbies;
}

export function register(guildId, discordId, steamId, name, seedRecordIds = [], primed = true) {
  guild(guildId).players[discordId] = {
    steamId,
    name: name || null,
    registeredAt: new Date().toISOString(),
    seen: seedRecordIds.slice(0, SEEN_LIMIT),
    // Only true when we actually captured their existing history. Claiming it
    // when the fetch failed makes the announcer treat every old run as new and
    // flood the channel with the player's entire back-catalogue.
    primed,
  };
  persist();
}

export function unregister(guildId, discordId) {
  const g = guild(guildId);
  const existed = Boolean(g.players[discordId]);
  delete g.players[discordId];
  persist();
  return existed;
}

/** Push newly-seen record ids to the front of a player's bounded seen-list. */
export function addSeen(player, recordIds) {
  player.seen = [...recordIds, ...(player.seen || [])].slice(0, SEEN_LIMIT);
  player.primed = true;
}
