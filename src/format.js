import { EmbedBuilder } from 'discord.js';
import { steamIdTo64 } from './steamid.js';
import { tierLabel } from './tiers.js';

/** 33185.8 -> "33,186" */
export function formatNumber(n) {
  return Math.round(Number(n) || 0)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 44.8671875 -> "44.867", 83.4 -> "1:23.400" */
export function formatTime(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const msPart = String(ms).padStart(3, '0');
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${msPart}` : `${s}.${msPart}`;
}

export function modeLabel(mode) {
  return mode === 'vanilla' ? 'Vanilla (VNL)' : 'Classic (CKZ)';
}

/** A record is "PRO" when it was set with zero teleports. */
function isPro(record) {
  return (record.teleports ?? 0) === 0;
}

/** Best available points/rank for a record, preferring PRO figures for teleport-free runs. */
export function recordPoints(record) {
  const pts = isPro(record) ? record.pro_points : record.nub_points;
  return pts ?? record.nub_points ?? 0;
}

/** "#1 / 12" — position with the size of the field it was won against. */
function rankValue(position, total) {
  if (position == null) return '—';
  return total ? `**#${position}** / ${total}` : `**#${position}**`;
}

/**
 * Render a standing for one scope ('sg' or 'global'), one line per ladder.
 * Teleport-free runs get both PRO and Any; TP runs only exist on Any, and are
 * shown unlabelled since there's nothing to disambiguate.
 */
function standingLines(standing, scope) {
  // "—" would read as "no rank". A failed board fetch is not a placement.
  if (!standing) return '_unavailable_';
  const total = `${scope}Total`;
  const lines = [];

  if (standing.pro) lines.push(`🟢 PRO ${rankValue(standing.pro[scope], standing.pro[total])}`);
  if (standing.any) {
    lines.push(
      standing.pro
        ? `🔵 Any ${rankValue(standing.any[scope], standing.any[total])}`
        : rankValue(standing.any[scope], standing.any[total]),
    );
  }
  return lines.join('\n') || '—';
}

export function recordEmbed(record, discordId, standing = null) {
  const pro = isPro(record);
  const rank = pro ? record.pro_rank : record.nub_rank;
  const points = pro ? record.pro_points : record.nub_points;
  const proTier = record.course?.pro_tier;
  const anyTier = record.course?.nub_tier;
  const steam64 = steamIdTo64(record.player?.id);

  const embed = new EmbedBuilder()
    .setColor(pro ? 0x2ecc71 : 0x3498db)
    .setTitle('🏁 New CS2KZ record!')
    .setDescription(`<@${discordId}> just finished a run.`)
    .addFields(
      { name: 'Map', value: record.map?.name ?? 'Unknown', inline: true },
      { name: 'Course', value: record.course?.name ?? 'Main', inline: true },
      { name: 'Mode', value: modeLabel(record.mode), inline: true },
      { name: 'Time', value: `\`${formatTime(record.time)}\``, inline: true },
      {
        name: 'Type',
        value: pro ? '🟢 PRO (0 TP)' : `🔵 ${record.teleports} TP`,
        inline: true,
      },
    );

  // Standing on this course. A teleport-free run sits on both ladders, so label
  // each one — otherwise the same run looks differently ranked depending on
  // which board you happen to be looking at.
  embed.addFields(
    { name: '🏠 Secret Garden', value: standingLines(standing, 'sg'), inline: true },
    {
      name: '🌍 Global',
      // The record carries its own rank, so that stays accurate even when the
      // course board couldn't be fetched.
      value: standing ? standingLines(standing, 'global') : rankValue(rank, null),
      inline: true,
    },
  );

  if (points != null) {
    embed.addFields({ name: 'Points', value: points.toFixed(1), inline: true });
  }
  // Courses carry a separate difficulty for each ladder, so a teleport-free run
  // shows both — matching the rank fields above rather than contradicting them.
  const tierLines = [];
  if (pro && proTier) tierLines.push(`🟢 PRO ${tierLabel(proTier)}`);
  if (anyTier) tierLines.push(pro ? `🔵 Any ${tierLabel(anyTier)}` : tierLabel(anyTier));
  else if (!pro && proTier) tierLines.push(tierLabel(proTier));
  if (tierLines.length) {
    embed.addFields({ name: 'Tier', value: tierLines.join('\n'), inline: true });
  }
  if (record.server?.name) {
    embed.setFooter({ text: `Server: ${record.server.name}` });
  }
  if (steam64) {
    embed.setURL(`https://steamcommunity.com/profiles/${steam64}`);
    embed.setAuthor({ name: record.player?.name ?? 'Player' });
  }
  return embed;
}
