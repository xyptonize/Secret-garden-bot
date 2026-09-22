import { EmbedBuilder } from 'discord.js';
import { formatTime } from './format.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * When a run was set, in ms. The API gives no timestamp, but CS2KZ record ids
 * are UUIDv7, whose first 48 bits are the creation time in milliseconds.
 */
export function runTime(record) {
  const ms = parseInt(String(record.id).replace(/-/g, '').slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Does a completed record satisfy a bounty's requirements? */
export function matchesBounty(record, bounty) {
  if (norm(record.map?.name) !== norm(bounty.map)) return false;
  if (bounty.course && norm(record.course?.name) !== norm(bounty.course)) return false;
  if (bounty.mode) {
    const apiMode = bounty.mode === 'vnl' ? 'vanilla' : 'classic';
    if (record.mode !== apiMode) return false;
  }
  if (bounty.type === 'pro' && (record.teleports ?? 0) !== 0) return false;
  return true;
}

/** Human-readable description of what a bounty targets. */
export function bountyTarget(bounty) {
  let text = `\`${bounty.map}\``;
  if (bounty.course && !/^main$/i.test(bounty.course)) text += ` — ${bounty.course}`;
  const tags = [];
  if (bounty.mode) tags.push(bounty.mode.toUpperCase());
  if (bounty.type === 'pro') tags.push('PRO only');
  if (tags.length) text += ` (${tags.join(', ')})`;
  return text;
}

/** Short unique id not already used in `existing`. */
export function newBountyId(existing) {
  let id;
  do {
    id = Math.random().toString(36).slice(2, 7);
  } while (existing.some((b) => b.id === id));
  return id;
}

export function bountyClaimEmbed(bounty, record, claimerId) {
  return new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle('🎯 Bounty claimed!')
    .setDescription(`<@${claimerId}> beat ${bountyTarget(bounty)} and claimed the bounty!`)
    .addFields(
      { name: 'Reward', value: bounty.reward, inline: true },
      { name: 'Time', value: `\`${formatTime(record.time)}\``, inline: true },
      { name: 'Run', value: (record.teleports ?? 0) === 0 ? 'PRO (0 TP)' : `${record.teleports} TP`, inline: true },
      { name: 'Course', value: record.course?.name ?? 'Main', inline: true },
    )
    .setFooter({ text: `Bounty #${bounty.id}` })
    .setTimestamp();
}
