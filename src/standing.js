// Where a run places on its course — globally, and among this server's members.
//
// The course leaderboard is one API call, and a player's position in it is their
// global rank (this reproduces the API's own pro_rank / nub_rank exactly).
// Filtering that same list to registered members gives the Secret Garden rank
// for free, without a request per member.
//
// There are two ladders per course and they give very different numbers:
//
//   Any   every completion, teleports allowed  (the API's "nub" rank)
//   PRO   teleport-free completions only       (the API's "pro" rank)
//
// A teleport-free run appears on BOTH, so we place it on both — reporting only
// one makes the same run look like it has two contradictory ranks depending on
// where you look.

import * as kz from './kzApi.js';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // course+ladder key -> { at, board }

/** A run with no teleports is judged on the PRO ladder as well as the Any one. */
const isPro = (record) => (record.teleports ?? 0) === 0;

async function loadBoard(record, pro) {
  const key = [record.map?.name, record.course?.name, record.mode, pro ? 'pro' : 'any'].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.board;

  const board = await kz.getCourseLeaderboard({
    map: record.map?.name,
    course: record.course?.name,
    mode: record.mode,
    pro,
  });

  cache.set(key, { at: Date.now(), board });
  // Several members finishing the same course in one tick reuse this; the map
  // would otherwise grow without bound over a long uptime.
  if (cache.size > 200) {
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
  }
  return board;
}

/** Place one player on one ladder. */
async function place(record, memberIds, pro) {
  let board;
  try {
    board = await loadBoard(record, pro);
  } catch (err) {
    console.error(`Could not fetch ${pro ? 'PRO' : 'Any'} board for ${record.map?.name}:`, err.message);
    return null;
  }
  if (!board.length) return null;

  const playerId = record.player?.id;
  const globalIndex = board.findIndex((r) => r.player?.id === playerId);
  if (globalIndex < 0) return null; // board is a moment behind this submission
  // Their entry is a different run (an older PB, or this run isn't a PB at all):
  // don't present that rank as this run's.
  if (board[globalIndex].id !== record.id) return null;

  const members = new Set(memberIds);
  const sgBoard = board.filter((r) => members.has(r.player?.id));
  const sgIndex = sgBoard.findIndex((r) => r.player?.id === playerId);

  return {
    global: globalIndex + 1,
    globalTotal: board.length,
    sg: sgIndex < 0 ? null : sgIndex + 1,
    sgTotal: sgBoard.length,
  };
}

/**
 * @param {object} record        the run to place
 * @param {string[]} memberIds   SteamIDs of registered members
 * @returns {Promise<{isPro:boolean, any:object|null, pro:object|null}|null>}
 *          null when nothing could be determined — callers should still
 *          announce the run, just without these figures.
 */
export async function courseStanding(record, memberIds = []) {
  if (!record.player?.id || !record.map?.name || !record.course?.name) return null;

  const pro = isPro(record);
  const [any, proStanding] = await Promise.all([
    place(record, memberIds, false),
    pro ? place(record, memberIds, true) : Promise.resolve(null),
  ]);

  if (!any && !proStanding) return null;
  return { isPro: pro, any, pro: proStanding };
}
