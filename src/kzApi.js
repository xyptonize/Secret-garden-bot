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

  return async function get(key, load) {
    const hit = entries.get(key) || {};
    if (hit.value !== undefined && Date.now() - hit.at < ttlMs) return hit.value;
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
  };
}

// The approved map list changes rarely; personal bests only between runs.
const mapsCache = cached(15 * 60 * 1000);
const pbCache = cached(60 * 1000);

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
export async function getPersonalBests({ player, mode, hasTeleports, limit = 1000 } = {}) {
  return pbCache(`${player}|${mode}|${hasTeleports}|${limit}`, () =>
    fetchPersonalBests({ player, mode, hasTeleports, limit }),
  );
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
