import { config } from './config.js';

async function apiGet(path, params) {
  const url = new URL(config.apiBase + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined) url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CS2KZ API ${res.status} on ${url.pathname}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Small TTL cache with two properties that matter here:
 *   - concurrent callers share one in-flight request instead of stampeding,
 *   - if a refresh fails but we still hold a stale value, the stale value wins
 *     over an error. The API is occasionally slow enough to hit our timeout, and
 *     a slightly old map list beats a dead command.
 */
function cached(ttlMs) {
  const entries = new Map(); // key -> { at, value, promise }

  async function get(key, load, { force = false } = {}) {
    const hit = entries.get(key) || {};
    if (!force && hit.value !== undefined && Date.now() - hit.at < ttlMs) return hit.value;
    if (hit.promise) return hit.promise;

    const promise = load()
      .then((value) => {
        entries.set(key, { at: Date.now(), value });
        return value;
      })
      .catch((err) => {
        entries.set(key, { ...hit, promise: null });
        if (hit.value !== undefined) {
          console.error(`CS2KZ API refresh failed (${key}), serving cached copy:`, err.message);
          return hit.value;
        }
        throw err;
      })
      .finally(() => {
        const current = entries.get(key);
        if (current?.promise === promise) entries.set(key, { ...current, promise: null });
      });

    entries.set(key, { ...hit, promise });
    return promise;
  }

  /** When the cached copy was fetched, in ms — for an honest "as of" line. */
  get.fetchedAt = (key) => entries.get(key)?.at ?? null;
  return get;
}

// The approved map list changes rarely, and personal bests only when someone
// plays. The CS2KZ API takes 9-14s for a PB query, so a short TTL made every
// page flip of /finished and /unfinished a fresh (often timing out) request.
const mapsCache = cached(15 * 60 * 1000);
const PB_TTL_MS = 15 * 60 * 1000;
const pbCache = cached(PB_TTL_MS);

// The global top by CKZ rating, for "where do I stand among everyone".
const topCache = cached(10 * 60 * 1000);

/**
 * The highest-rated players, best first, plus how many players exist in total.
 * The API caps a page at 1000, so this pages until `limit` (3000 reaches about
 * rating 2,150 — deep enough to place nearly everyone in a normal server).
 */
export async function getTopPlayers({ limit = 3000 } = {}) {
  return topCache(`top|${limit}`, async () => {
    const values = [];
    let total = 0;
    for (let offset = 0; offset < limit; offset += 1000) {
      const data = await apiGet('/players', {
        limit: Math.min(1000, limit - offset),
        offset,
        sort_by: 'ckz-rating',
        sort_order: 'descending',
      });
      const page = data?.values ?? [];
      total = data?.total ?? total;
      values.push(...page);
      if (page.length < 1000) break; // ran out of players
    }
    return { values, total };
  });
}

/**
 * Where a SteamID sits among all CS2KZ players by CKZ rating.
 * { rank, total, coverage } — rank is null when they're outside the snapshot.
 */
export async function globalStanding(steamId) {
  const { values, total } = await getTopPlayers();
  const at = values.findIndex((p) => p.id === steamId);
  return { rank: at < 0 ? null : at + 1, total, coverage: values.length };
}

/** Look up a single player. Returns the player object, or null if not found (404). */
export async function getPlayer(steamId) {
  return apiGet(`/players/${encodeURIComponent(steamId)}`);
}

/** Fetch a player's records, newest first. Returns an array (possibly empty). */
export async function getRecords({ player, limit = 15 } = {}) {
  const data = await apiGet('/records', {
    player,
    limit,
    sort_by: 'submission-date',
    sort_order: 'descending',
  });
  return data?.values ?? [];
}

/**
 * A player's personal-best records for a mode (one per course completed).
 * hasTeleports === false -> only teleport-free (PRO) completions.
 * hasTeleports === undefined -> any completion (TP/overall).
 */
export async function getPersonalBests({ player, mode, hasTeleports, limit = 1000, force = false } = {}) {
  const key = `${player}|${mode}|${hasTeleports}|${limit}`;
  return pbCache(key, () => fetchPersonalBests({ player, mode, hasTeleports, limit }), { force });
}

/** When this player's personal bests were last fetched (ms), or null. */
export function personalBestsFetchedAt({ player, mode, hasTeleports, limit = 1000 } = {}) {
  return pbCache.fetchedAt(`${player}|${mode}|${hasTeleports}|${limit}`);
}

async function fetchPersonalBests({ player, mode, hasTeleports, limit }) {
  const data = await apiGet('/records', {
    player,
    mode, // 'classic' | 'vanilla'
    top: true, // PBs only
    has_teleports: hasTeleports, // omitted when undefined
    limit,
  });
  return data?.values ?? [];
}

/**
 * Every personal best on one course, fastest first — i.e. that course's
 * leaderboard. Position in this list is the run's global rank (verified to
 * match the API's own pro_rank / nub_rank).
 *
 * `pro` selects which ladder: teleport-free runs only (matching pro_rank), or
 * every completion (matching nub_rank).
 */
export async function getCourseLeaderboard({ map, course, mode, pro = false, pageSize = 1000 } = {}) {
  const all = [];
  let offset = 0;
  for (;;) {
    const data = await apiGet('/records', {
      map,
      course,
      mode,
      top: true, // personal bests only, so each player appears once
      has_teleports: pro ? false : undefined,
      sort_by: 'time',
      sort_order: 'ascending',
      limit: pageSize,
      offset,
    });
    const values = data?.values ?? [];
    all.push(...values);
    const total = data?.total ?? all.length;
    if (values.length < pageSize || all.length >= total) break;
    offset += pageSize;
    if (offset > 50000) break; // safety net
  }
  return all;
}

/**
 * Every approved map with its courses (paginates defensively).
 * A map name can have several versions with different ids (e.g. kz_divert has
 * ids 27/69/70, the older ones now "invalid"). We keep only the newest approved
 * one so the same map isn't listed or counted multiple times.
 */
export async function getAllMaps({ pageSize = 500 } = {}) {
  return mapsCache(`maps|${pageSize}`, () => fetchAllMaps({ pageSize }));
}

async function fetchAllMaps({ pageSize }) {
  const all = [];
  let offset = 0;
  for (;;) {
    const data = await apiGet('/maps', { limit: pageSize, offset });
    const values = data?.values ?? [];
    all.push(...values);
    const total = data?.total ?? all.length;
    if (values.length < pageSize || all.length >= total) break;
    offset += pageSize;
    if (offset > 20000) break; // safety net
  }

  const newestByName = new Map();
  for (const m of all) {
    // Maps pulled from rotation stay in /maps as "invalid" (and the API ignores
    // ?state=), so filter here — otherwise removed maps linger in every list.
    if (m.state && m.state !== 'approved') continue;
    const prev = newestByName.get(m.name);
    if (!prev || m.id > prev.id) newestByName.set(m.name, m);
  }
  return [...newestByName.values()];
}
