import { config } from './config.js';
import * as store from './store.js';
import * as kz from './kzApi.js';
import { recordEmbed, recordPoints } from './format.js';
import { matchesBounty, bountyClaimEmbed, runTime } from './bounty.js';
import { courseStanding } from './standing.js';
import { maybeDropCase } from './cases.js';

// Record queries are the slow ones (9-14s each), and the API slows further
// under parallel load, so only a couple run at once. The rating sweep is a
// different endpoint and answers in milliseconds, so it can go wider.
const WORKERS = 2;
const SWEEP_WORKERS = 8;
// Runs that earn no points (slower than a personal best) don't move a rating,
// so a few players are fully checked every tick anyway, round robin.
const BACKSTOP_PER_TICK = 4;
let backstopAt = 0;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
// A bounty waits this many ticks for members whose lookup failed, in case one
// of them finished first.
const BOUNTY_WAIT_TICKS = 3;

/**
 * Poll on a timer that reschedules itself after each tick, so ticks can never
 * overlap (two overlapping ticks would post the same run twice) and none are
 * skipped. If most lookups fail (API down), wait longer, doubling up to 10 min.
 */
export function startAnnouncer(client) {
  let backoff = 0;
  const loop = async () => {
    const started = Date.now();
    let result = null;
    try {
      result = await tick(client);
    } catch (err) {
      console.error('Announcer tick failed:', err);
    }
    const took = Date.now() - started;
    if (took > config.pollIntervalMs) {
      console.warn(`Announcer tick took ${Math.round(took / 1000)}s (interval ${config.pollIntervalMs / 1000}s).`);
    }
    const apiDown = result && result.total > 0 && result.failed * 2 >= result.total;
    backoff = apiDown ? Math.min(MAX_BACKOFF_MS, (backoff || config.pollIntervalMs) * 2) : 0;
    if (apiDown) console.warn(`CS2KZ API struggling (${result.failed}/${result.total} lookups failed) — next check in ${Math.round(backoff / 1000)}s.`);
    setTimeout(loop, backoff || Math.max(5000, config.pollIntervalMs - took));
  };
  loop();
  console.log(`📡 Announcer running every ${config.pollIntervalMs / 1000}s.`);
}

/** Run `job` over `items` with a fixed number of workers. */
async function pooled(items, workers, job) {
  const queue = [...items];
  const run = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await job(item);
  };
  await Promise.all(Array.from({ length: workers }, run));
}

/**
 * The cheap question: has anyone's rating moved? One /players lookup each,
 * milliseconds apiece, so every registered member can be checked every tick.
 */
async function sweepRatings(steamIds) {
  const ratings = new Map(); // steamId -> { ckz, vnl, name } | null when the lookup failed
  let failed = 0;
  await pooled(steamIds, SWEEP_WORKERS, async (steamId) => {
    try {
      const data = await kz.getPlayer(steamId);
      ratings.set(steamId, data ? { ckz: data.ckz_rating ?? 0, vnl: data.vnl_rating ?? 0, name: data.name } : null);
    } catch (err) {
      failed += 1;
      console.error(`Rating sweep failed for ${steamId}:`, err.message);
    }
  });
  return { ratings, failed };
}

/** The players to fully check this tick: the few in the rotation. */
function backstop(steamIds, count) {
  const all = [...steamIds];
  const take = [];
  for (let i = 0; i < Math.min(count, all.length); i++) {
    take.push(all[(backstopAt + i) % all.length]);
  }
  backstopAt = all.length ? (backstopAt + take.length) % all.length : 0;
  return take;
}

/** A player's newest runs, WORKERS at a time. null = lookup failed. */
async function fetchAll(steamIds) {
  const queue = [...steamIds];
  const recordsBySteam = new Map();
  let failed = 0;
  const worker = async () => {
    for (let steamId = queue.shift(); steamId; steamId = queue.shift()) {
      try {
        recordsBySteam.set(steamId, await kz.getRecords({ player: steamId, limit: 15 }));
      } catch (err) {
        recordsBySteam.set(steamId, null); // skip this player this round
        failed += 1;
        console.error(`Failed to fetch records for ${steamId}:`, err.message);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { recordsBySteam, failed };
}

export async function tick(client) {
  const guilds = store.allGuilds();

  // Fetch each unique SteamID once, even if registered in several servers.
  const steamIds = new Set();
  for (const g of Object.values(guilds)) {
    for (const p of Object.values(g.players)) steamIds.add(p.steamId);
  }
  if (steamIds.size === 0) return { total: 0, failed: 0 };

  // 1) Cheap sweep: whose rating moved since last tick?
  const { ratings, failed: sweepFailed } = await sweepRatings([...steamIds]);
  const moved = new Set();
  const openBounty = Object.values(guilds).some((g) => (g.bounties || []).some((b) => b.active && !b.claimedBy));
  for (const g of Object.values(guilds)) {
    for (const p of Object.values(g.players)) {
      const now = ratings.get(p.steamId);
      if (!p.primed) moved.add(p.steamId); // never checked: fetch their history
      else if (now && (now.ckz !== p.rating?.ckz || now.vnl !== p.rating?.vnl)) moved.add(p.steamId);
    }
  }
  // 2) Only those players get the slow record query — plus a rotating few (runs
  // that earn no points move no rating), and everyone while a bounty is open,
  // where "who finished first" has to be exact.
  const wanted = new Set(moved);
  for (const id of openBounty ? steamIds : backstop(steamIds, BACKSTOP_PER_TICK)) wanted.add(id);

  const { recordsBySteam, failed: recordsFailed } = await fetchAll(wanted);
  const failed = sweepFailed + recordsFailed;
  let dirty = false;

  for (const [guildId, g] of Object.entries(guilds)) {
    const channelId = g.announceChannelId || config.announceChannelId;
    const minPoints = g.minPoints ?? config.minPoints;
    // Everyone registered here, so a run can be placed against the server as
    // well as against the world.
    const memberIds = Object.values(g.players).map((p) => p.steamId);
    let channel = null; // resolved lazily, only if we actually have something to post
    const getChannel = async () => {
      if (channel === null) {
        try {
          channel = await client.channels.fetch(channelId);
        } catch (err) {
          console.error(`Cannot fetch announce channel ${channelId}:`, err.message);
          channel = false; // don't retry every player
        }
      }
      return channel;
    };

    for (const [discordId, player] of Object.entries(g.players)) {
      const records = recordsBySteam.get(player.steamId);
      if (!records) continue;

      // Whatever we just fetched is accounted for: remember the rating that
      // produced it, so the next sweep only flags real movement.
      const swept = ratings.get(player.steamId);
      if (swept && (player.rating?.ckz !== swept.ckz || player.rating?.vnl !== swept.vnl)) {
        player.rating = { ckz: swept.ckz, vnl: swept.vnl };
        dirty = true;
      }

      // Keep the cached display name fresh.
      const latestName = swept?.name || records[0]?.player?.name;
      if (latestName && player.name !== latestName) {
        player.name = latestName;
        dirty = true;
      }

      // First time we ever see this player: capture history, announce nothing.
      if (!player.primed) {
        store.addSeen(player, records.map((r) => r.id));
        dirty = true;
        continue;
      }

      const seen = new Set(player.seen || []);
      const fresh = records.filter((r) => !seen.has(r.id));
      if (fresh.length === 0) continue;

      // A record is only "settled" once it can never need announcing again —
      // either it was posted, or it was never going to be. Anything else stays
      // unseen so the next tick retries it, instead of the run being lost to a
      // permissions outage or a Discord hiccup.
      const settled = new Set();

      // Announce oldest-first so the channel reads chronologically.
      const ordered = fresh.slice().reverse();
      const toAnnounce = ordered.filter((r) => recordPoints(r) >= minPoints);

      // Below the points threshold: deliberately never announced, so done with.
      for (const r of ordered) if (recordPoints(r) < minPoints) settled.add(r.id);

      if (toAnnounce.length > 0) {
        if (!channelId) {
          // No announce channel configured at all. Treat these as handled —
          // otherwise they'd pile up and flood the channel the moment one is set.
          for (const r of toAnnounce) settled.add(r.id);
        } else if (await getChannel()) {
          for (const r of toAnnounce) {
            try {
              // Never let a standing lookup block the announcement itself.
              const standing = await courseStanding(r, memberIds).catch(() => null);
              const posted = await channel.send({
                content: `<@${discordId}>`,
                embeds: [recordEmbed(r, discordId, standing)],
                allowedMentions: { users: [discordId] },
              });
              // Saved right away: a restart later in this tick must not post it again.
              store.addSeen(player, [r.id]);
              store.persist();
              // A run that actually made it to the channel can drop a case. Rolled
              // after the post, so a failed send never costs a roll or a case.
              if (maybeDropCase(guildId, discordId)) {
                await posted
                  .edit({
                    content: `<@${discordId}>\n🎁 **A Garden Case dropped!** Open it with \`/${config.caseRoot} open\``,
                    allowedMentions: { users: [] },
                  })
                  .catch(() => {});
              }
            } catch (err) {
              // Left unsettled on purpose: retried on the next tick.
              console.error(`Failed to post announcement (will retry): ${err.message}`);
            }
          }
        }
      }

      // The rest that are settled. `fresh` is newest-first, so keeping that order
      // means the oldest ids are the ones evicted when the list hits its cap.
      const done = fresh.filter((r) => settled.has(r.id)).map((r) => r.id);
      if (done.length) {
        store.addSeen(player, done);
        dirty = true;
      }
    }

    if (await resolveBounties(g, recordsBySteam, channelId ? getChannel : null)) dirty = true;
  }

  if (dirty) store.persist();
  return { total: steamIds.size, failed, checked: wanted.size };
}

/**
 * Award open bounties. Every registered member's recent runs are compared and
 * the bounty goes to whoever set a matching run FIRST (by submission time),
 * counting only runs set after the bounty was created (and after that member
 * registered). If some members couldn't be looked up this tick, wait a few
 * ticks for them — one of them might have finished earlier.
 *
 * The claim is saved before it's announced: the run wins the bounty even if
 * the post fails, and a restart can never award or announce it twice.
 */
async function resolveBounties(g, recordsBySteam, getChannel) {
  const open = (g.bounties || []).filter((b) => b.active && !b.claimedBy);
  if (!open.length) return false;
  const anyFailed = Object.values(g.players).some((p) => recordsBySteam.get(p.steamId) === null);
  let changed = false;

  for (const bounty of open) {
    const since = Date.parse(bounty.createdAt) || 0;
    let best = null;
    for (const [discordId, player] of Object.entries(g.players)) {
      const floor = Math.max(since, Date.parse(player.registeredAt) || 0);
      for (const r of recordsBySteam.get(player.steamId) || []) {
        const at = runTime(r);
        if (!(at >= floor) || !matchesBounty(r, bounty)) continue;
        if (!best || at < best.at) best = { record: r, discordId, at };
      }
    }
    if (!best) continue;
    if (anyFailed && (bounty.waits || 0) < BOUNTY_WAIT_TICKS) {
      bounty.waits = (bounty.waits || 0) + 1;
      changed = true;
      continue;
    }

    bounty.active = false;
    bounty.claimedBy = best.discordId;
    bounty.claimedRecordId = best.record.id;
    bounty.claimedAt = new Date().toISOString();
    delete bounty.waits;
    store.persist();
    changed = true;

    const channel = getChannel && (await getChannel());
    if (!channel) continue;
    try {
      await channel.send({
        content: `🎯 <@${best.discordId}> claimed <@${bounty.createdBy}>'s bounty!`,
        embeds: [bountyClaimEmbed(bounty, best.record, best.discordId)],
        allowedMentions: { users: [best.discordId, bounty.createdBy] },
      });
    } catch (err) {
      console.error(`Failed to post claim of bounty #${bounty.id} (claim still recorded): ${err.message}`);
    }
  }
  return changed;
}
