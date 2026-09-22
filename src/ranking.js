import * as store from './store.js';
import * as kz from './kzApi.js';

/**
 * Fetch every registered member's current rating for a mode.
 *
 * Returns { members, failed } — best-first, plus the members whose lookup
 * errored. Those two outcomes must stay apart: dropping a failed lookup makes a
 * member vanish from the leaderboard and turns "the API timed out" into
 * "they aren't ranked", which is a claim we can't actually support.
 *
 * A member the API positively reports as absent (404) is genuinely unranked and
 * is simply left out.
 *
 * Shared by /rankings, the pinned leaderboard, and role sync.
 */
export async function getRankedMembers(guildId, mode = 'ckz') {
  const players = store.getPlayers(guildId);

  const results = await Promise.all(
    Object.entries(players).map(async ([discordId, p]) => {
      try {
        const data = await kz.getPlayer(p.steamId);
        if (!data) return { discordId, absent: true };
        const rating = mode === 'vnl' ? data.vnl_rating : data.ckz_rating;
        return { discordId, steamId: p.steamId, name: data.name, rating };
      } catch (err) {
        return { discordId, name: p.name, failed: err.message };
      }
    }),
  );

  const members = results
    .filter((e) => !e.failed && !e.absent && typeof e.rating === 'number')
    .sort((a, b) => b.rating - a.rating);

  const failed = results.filter((e) => e.failed);
  if (failed.length) {
    console.error(
      `getRankedMembers(${guildId}): ${failed.length} lookup(s) failed — ` +
        failed.map((f) => `${f.name || f.discordId}: ${f.failed}`).join('; '),
    );
  }

  return { members, failed };
}
