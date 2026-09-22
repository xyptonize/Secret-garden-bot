// Betting seeds on /sgdraft matches.
//
// Pari-mutuel, because it is the only shape that is exactly fair without the
// bot taking a position: every seed staked on a match goes into one pot, and
// when the host marks the winner the pot is split among whoever backed that
// team, in proportion to what they put in. The bot keeps nothing, and if a
// match is cancelled — or nobody backed the winner — every stake goes home.

import * as store from './store.js';
import { wallet } from './cases.js';
import { config } from './config.js';

const SEED = '🌱';
const money = (n) => `${SEED} **${Math.round(n).toLocaleString('en-US')}**`;
const TEAM_EMOJI = ['🟥', '🟦', '🟩', '🟨', '🟪', '🟧', '⬜', '🟫'];
export const teamName = (i) => `${TEAM_EMOJI[i % TEAM_EMOJI.length]} Team ${i + 1}`;

const matchKey = (round, match) => `${round}.${match}`;

function pools(lobby) {
  if (!lobby.pools) lobby.pools = {};
  return lobby.pools;
}

/** Every match in this server that can still be backed. */
export function openMatches(guildId) {
  const out = [];
  for (const [key, lobby] of Object.entries(store.getDraftLobbies())) {
    if (lobby.guildId !== guildId || !lobby.bracket || lobby.test) continue;
    lobby.bracket.rounds.forEach((round, r) => {
      round.forEach((m, i) => {
        if (m.winner != null || m.a == null || m.b == null) return; // decided, or a bye
        out.push({
          lobbyKey: lobby.key ?? key,
          lobby,
          round: r,
          match: i,
          id: `${lobby.key ?? key}|${matchKey(r, i)}`,
          teams: [m.a, m.b],
          label: `${lobby.title} — ${teamName(m.a)} vs ${teamName(m.b)}`,
        });
      });
    });
  }
  return out;
}

export function findMatch(guildId, id) {
  return openMatches(guildId).find((m) => m.id === id) || null;
}

/** What is riding on a match: totals per team and who is in. */
export function poolOf(lobby, round, match) {
  const bets = pools(lobby)[matchKey(round, match)] || {};
  const byTeam = new Map();
  let total = 0;
  for (const { team, amount } of Object.values(bets)) {
    byTeam.set(team, (byTeam.get(team) || 0) + amount);
    total += amount;
  }
  return { bets, byTeam, total };
}

/**
 * Back a team. The stake leaves the wallet here and lives in the pool until the
 * match is settled or refunded. Adding to a bet you already have is fine;
 * switching sides is not — that would be a free hedge once the game has begun.
 */
export function placeBet(guildId, userId, id, team, amount) {
  const found = findMatch(guildId, id);
  if (!found) return { error: 'That match has already been decided, or the lobby is gone.' };
  if (!found.teams.includes(team)) return { error: 'That team is not in this match.' };

  const p = wallet(guildId, userId);
  if (!Number.isInteger(amount) || amount < config.casinoMinBet) return { error: `The smallest bet is ${money(config.casinoMinBet)}.` };
  if (amount > config.casinoMaxBet) return { error: `The biggest bet is ${money(config.casinoMaxBet)}.` };
  if ((p.seeds || 0) < amount) return { error: `You only have ${money(p.seeds || 0)}.` };
  // Either side: betting AGAINST your own team is the one bet that could pay
  // someone to lose, so nobody in the match may back anybody in it.
  const playing = found.teams.some((t) => found.lobby.result?.teams?.[t]?.some((pl) => pl.id === userId));
  if (playing) return { error: "You're playing in this match — you can't bet on it, either way." };

  const all = pools(found.lobby);
  const key = matchKey(found.round, found.match);
  if (!all[key]) all[key] = {};
  const mine = all[key][userId];
  if (mine && mine.team !== team) {
    return { error: `You already backed ${teamName(mine.team)} here. You can add to that, but not swap sides.` };
  }
  if (mine && mine.amount + amount > config.casinoMaxBet) {
    return { error: `That would put ${money(mine.amount + amount)} on one match — the limit is ${money(config.casinoMaxBet)}.` };
  }

  p.seeds -= amount;
  all[key][userId] = { team, amount: (mine?.amount || 0) + amount };
  store.persist();
  return { match: found, staked: all[key][userId].amount, pool: poolOf(found.lobby, found.round, found.match) };
}

/**
 * Pay out a decided match. Winners split the whole pot in proportion to their
 * stake; the rounding remainder goes to the largest backer so that not one seed
 * is created or destroyed. Returns a line for the result post, or null.
 */
export function settleMatch(lobby, round, match, winner) {
  const all = pools(lobby);
  const key = matchKey(round, match);
  const bets = all[key];
  if (!bets || !Object.keys(bets).length) return null;
  delete all[key];

  const entries = Object.entries(bets);
  const total = entries.reduce((n, [, b]) => n + b.amount, 0);
  const winners = entries.filter(([, b]) => b.team === winner);
  const guildId = lobby.guildId;

  if (!winners.length) {
    for (const [userId, b] of entries) wallet(guildId, userId).seeds += b.amount;
    store.persist();
    return `💰 Nobody backed ${teamName(winner)} — all ${money(total)} refunded.`;
  }

  const backed = winners.reduce((n, [, b]) => n + b.amount, 0);
  let handed = 0;
  const paid = winners
    .map(([userId, b]) => {
      const share = Math.floor((b.amount * total) / backed);
      handed += share;
      return { userId, share, staked: b.amount };
    })
    .sort((a, b) => b.share - a.share);
  if (total - handed > 0) paid[0].share += total - handed; // the rounding remainder
  for (const { userId, share } of paid) wallet(guildId, userId).seeds += share;
  store.persist();

  const top = paid
    .slice(0, 3)
    .map((w) => `<@${w.userId}> ${money(w.share)}`)
    .join(' · ');
  return `💰 ${money(total)} on ${teamName(winner)} → ${top}${paid.length > 3 ? ` and ${paid.length - 3} more` : ''}`;
}

/**
 * Give every open stake in this lobby back — the bracket was cancelled, the
 * lobby closed, or the teams were redrawn under the bets.
 */
export function refundLobby(lobby) {
  const all = lobby.pools;
  if (!all) return 0;
  let total = 0;
  for (const bets of Object.values(all)) {
    for (const [userId, b] of Object.entries(bets)) {
      wallet(lobby.guildId, userId).seeds += b.amount;
      total += b.amount;
    }
  }
  delete lobby.pools;
  if (total) store.persist();
  return total;
}
