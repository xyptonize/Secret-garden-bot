import { EmbedBuilder } from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import { getRankedMembers } from './ranking.js';
import { RANKS, rankFor } from './ranks.js';
import { ensureRankRoles, syncMemberRoles } from './roles.js';
import { formatNumber } from './format.js';

const MEDALS = ['🥇', '🥈', '🥉'];

const rankIndex = (name) => RANKS.findIndex((r) => r.name === name);

function rankUpEmbed(entry, newRank, prevName) {
  return new EmbedBuilder()
    .setColor(newRank.color)
    .setTitle('🎉 Rank up!')
    .setDescription(`<@${entry.discordId}> climbed to **${config.rankRolePrefix} ${newRank.name}**!`)
    .addFields(
      { name: 'From', value: prevName, inline: true },
      { name: 'To', value: newRank.name, inline: true },
      { name: 'CKZ rating', value: formatNumber(entry.rating), inline: true },
    )
    .setTimestamp();
}

/**
 * Detect members who crossed into a higher rank since the last sync and
 * announce it. Primes silently on first sight (and after a ladder rename)
 * so it never announces existing ranks; never announces rank-downs.
 */
async function announceRankChanges(client, guildId, g, entries) {
  const players = store.getPlayers(guildId);
  const channelId = g.announceChannelId || config.announceChannelId;
  let channel = null; // resolved lazily; false once known-unavailable
  let dirty = false;

  for (const e of entries) {
    const player = players[e.discordId];
    if (!player) continue;
    const newRank = rankFor(e.rating);
    if (!newRank) continue;

    const prevName = player.rank;
    // No baseline yet, or the ladder was renamed away from the stored name: prime, no announce.
    if (prevName == null || rankIndex(prevName) === -1) {
      if (player.rank !== newRank.name) {
        player.rank = newRank.name;
        dirty = true;
      }
      continue;
    }
    if (newRank.name === prevName) continue;

    const isRankUp = rankIndex(newRank.name) > rankIndex(prevName);

    // Announce before recording the new rank. Recording it first means a failed
    // send (missing permissions, Discord hiccup) leaves the rank marked as
    // already-announced, and that rank-up is gone for good — it can only ever
    // happen once. A rank-down needs no message, so it's recorded immediately.
    if (isRankUp && channelId) {
      if (channel === null) {
        try {
          channel = await client.channels.fetch(channelId);
        } catch (err) {
          console.error(`Cannot fetch announce channel ${channelId}:`, err.message);
          channel = false;
        }
      }
      if (channel) {
        try {
          await channel.send({
            content: `<@${e.discordId}>`,
            embeds: [rankUpEmbed(e, newRank, prevName)],
            allowedMentions: { users: [e.discordId] },
          });
        } catch (err) {
          // Leave player.rank untouched so the next sync retries this rank-up.
          console.error(`Failed to post rank-up for ${e.discordId} (will retry):`, err.message);
          continue;
        }
      } else {
        continue; // no reachable channel yet — retry on the next sync
      }
    }

    player.rank = newRank.name;
    dirty = true;
  }
  if (dirty) store.persist();
}

export function buildLeaderboardEmbed(entries, failed = []) {
  const lines = entries.slice(0, 25).map((e, i) => {
    const pos = MEDALS[i] || `\`#${String(i + 1).padStart(2, '0')}\``;
    const rank = rankFor(e.rating);
    return `${pos} **${e.name}** · \`${formatNumber(e.rating)}\` · ${rank?.name ?? '—'} · <@${e.discordId}>`;
  });
  const mins = Math.round(config.leaderboardIntervalMs / 60000);
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏆 ${config.leaderboardTitle}`)
    .setDescription(
      lines.length ? lines.join('\n') : `No registered members yet. Use \`/${config.commandRoot} register\`.`,
    )
    .setFooter({
      text:
        `${entries.length} ranked member(s)` +
        (failed.length ? ` · ⚠️ ${failed.length} couldn't be loaded` : '') +
        ` · auto-updates every ${mins} min`,
    })
    .setTimestamp();
}

// guildId -> in-flight update. /leaderboard refresh and the timer can otherwise
// run side by side, and two concurrent runs both see the old player.rank and
// both announce the same rank-up.
const inFlight = new Map();

/** Refresh one guild's rank roles and pinned leaderboard message. */
export function updateGuild(client, guildId) {
  if (inFlight.has(guildId)) return inFlight.get(guildId);
  const promise = doUpdateGuild(client, guildId).finally(() => inFlight.delete(guildId));
  inFlight.set(guildId, promise);
  return promise;
}

/**
 * Returns what happened, for /leaderboard refresh to report honestly:
 * { board: 'ok' | 'none' | 'api-down' | 'deleted' | 'error', failed, roleErrors, error? }
 */
async function doUpdateGuild(client, guildId) {
  const g = store.getGuild(guildId);
  if (!g) return { board: 'none', failed: 0, roleErrors: 0 };

  const { members: entries, failed } = await getRankedMembers(guildId, 'ckz');
  const status = { board: 'none', failed: failed.length, roleErrors: 0 };

  // 1) Rank roles
  if (config.enableRankRoles) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const rolesByName = await ensureRankRoles(guild);
      for (const e of entries) {
        try {
          await syncMemberRoles(guild, e.discordId, e.rating, rolesByName);
        } catch (err) {
          status.roleErrors += 1;
          console.error(`Role sync failed for ${e.discordId} in ${guildId}:`, err.message);
        }
      }
    } catch (err) {
      status.roleErrors += 1;
      status.roleError = err.message;
      console.error(`Rank-role sync skipped for guild ${guildId}:`, err.message);
    }
  }

  // 2) Rank-up announcements (works even when rank roles are disabled)
  if (config.enableRankupAnnouncements) {
    await announceRankChanges(client, guildId, g, entries).catch((err) =>
      console.error(`Rank-up check failed for ${guildId}:`, err.message),
    );
  }

  // 3) Pinned leaderboard message
  const lb = g.leaderboard;
  // Every lookup failed (API down): keep the last good board rather than
  // replacing it with "No registered members yet".
  const apiDown = entries.length === 0 && failed.length > 0;
  if (apiDown) {
    console.error(`Leaderboard for ${guildId} left as-is: all ${failed.length} lookups failed.`);
    status.board = 'api-down';
  }
  if (lb?.channelId && lb?.messageId && !apiDown) {
    try {
      const channel = await client.channels.fetch(lb.channelId);
      // Edit directly (no fetch first): no Read Message History needed.
      await channel.messages.edit(lb.messageId, {
        embeds: [buildLeaderboardEmbed(entries, failed)],
        allowedMentions: { parse: [] },
      });
      status.board = 'ok';
    } catch (err) {
      console.error(`Failed to update leaderboard message in ${guildId}:`, err.message);
      status.board = err.code === 10008 ? 'deleted' : 'error';
      status.error = err.message;
    }
  }
  return status;
}

export async function updateAll(client) {
  for (const guildId of Object.keys(store.allGuilds())) {
    await updateGuild(client, guildId).catch((err) =>
      console.error(`updateGuild(${guildId}) failed:`, err.message),
    );
  }
}

export function startLeaderboardUpdater(client) {
  const run = () => updateAll(client).catch((err) => console.error('Leaderboard updater error:', err));
  setTimeout(run, 5000); // once shortly after startup
  setInterval(run, config.leaderboardIntervalMs);
  console.log(`📊 Leaderboard + rank-role updater running every ${config.leaderboardIntervalMs / 1000}s.`);
}
