// /sgprofile — everything SG-BOT knows about a member, on one card:
// their Discord standing in the server, what they've saved (birthday, socials,
// Steam), their CS2KZ ratings and their draft record.
//
// The reply is public, so a saved phone number is never printed — it only shows
// as "saved (private)". Use /sgphone view for the number itself.

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import * as kz from './kzApi.js';
import { savedContacts, steamLink } from './contacts.js';
import { steamIdTo64 } from './steamid.js';
import { rankFor } from './ranks.js';
import { formatNumber } from './format.js';
import { globalStandingText } from './commands.js';
import { playerStats } from './draftHistory.js';
import { auraOf } from './draft.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const TOP_ROLES = 4;

const day = (ms) => `<t:${Math.floor(ms / 1000)}:D>`;

/** "14 March", or "14 March 1999 · 27" when the year is known. */
function birthdayText(b) {
  const date = `${b.day} ${MONTHS[b.month - 1]}`;
  if (!b.year) return date;
  const now = new Date();
  const had = now.getMonth() + 1 > b.month || (now.getMonth() + 1 === b.month && now.getDate() >= b.day);
  return `${date} ${b.year} · ${now.getFullYear() - b.year - (had ? 0 : 1)}`;
}

async function execute(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  await interaction.deferReply();
  const guildId = interaction.guildId;

  let member = null;
  try {
    member = await interaction.guild.members.fetch({ user: user.id, force: true });
  } catch {
    // Left the server: still show what was saved.
  }

  const embed = new EmbedBuilder()
    .setColor(member?.displayColor || 0x5865f2)
    .setTitle(`👤 ${member?.displayName || user.globalName || user.username}`)
    .setFooter({ text: `SG-BOT · /${config.profileRoot}` });
  const avatar = (member ?? user).displayAvatarURL?.({ size: 256 });
  if (typeof avatar === 'string' && /^https?:\/\//.test(avatar)) embed.setThumbnail(avatar);

  // --- Discord standing in this server
  const discord = [`Account created ${day(user.createdTimestamp)}`];
  if (member?.joinedTimestamp) discord.unshift(`Joined this server ${day(member.joinedTimestamp)}`);
  if (member?.premiumSinceTimestamp) discord.push(`💎 Boosting since ${day(member.premiumSinceTimestamp)}`);
  if (member) {
    const roles = [...member.roles.cache.values()]
      .filter((r) => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position);
    if (roles.length) {
      const top = roles.slice(0, TOP_ROLES).map((r) => `<@&${r.id}>`).join(' ');
      discord.push(`Roles (${roles.length}): ${top}${roles.length > TOP_ROLES ? ' …' : ''}`);
    }
  } else {
    discord.push('_No longer in this server._');
  }
  embed.addFields({ name: '💬 Discord', value: discord.join('\n') });

  // --- Saved by the member
  const saved = savedContacts(guildId, user.id);
  const birthday = store.getBirthdays(guildId)[user.id];
  const personal = [];
  if (birthday) personal.push(`🎂 ${birthdayText(birthday)}`);
  if (saved.ig) personal.push(`📸 [@${saved.ig}](https://instagram.com/${saved.ig})`);
  if (saved.steam) personal.push(`🎮 [Steam profile](${steamLink(saved.steam)})`);
  if (saved.phone) personal.push(`📱 Saved — private (\`/${config.phoneRoot} view\`)`);
  embed.addFields({
    name: '🔗 Saved',
    value: personal.length
      ? personal.join('\n')
      : `Nothing yet — try \`/${config.birthdayRoot} set\`, \`/${config.igRoot} set\`, \`/${config.steamRoot} set\`.`,
  });

  // --- CS2KZ
  const player = store.findByDiscord(guildId, user.id);
  if (player) {
    const lines = [`SteamID \`${player.steamId}\``];
    const steam64 = steamIdTo64(player.steamId);
    if (steam64) lines[0] += ` · [profile](https://steamcommunity.com/profiles/${steam64})`;
    try {
      const [data, standing] = await Promise.all([
        kz.getPlayer(player.steamId),
        kz.globalStanding(player.steamId).catch(() => null),
      ]);
      if (data) {
        const rank = rankFor(data.ckz_rating);
        lines.push(
          `CKZ **${formatNumber(data.ckz_rating ?? 0)}**${rank ? ` · ${rank.name}` : ''} · VNL **${formatNumber(data.vnl_rating ?? 0)}**`,
          `🌍 Global ${globalStandingText(data.ckz_rating, standing)}`,
        );
      } else {
        lines.push('_Not in the CS2KZ database yet._');
      }
    } catch {
      lines.push("_Couldn't reach the CS2KZ API just now._");
    }
    embed.addFields({ name: '🏁 CS2KZ', value: lines.join('\n') });
  }

  // --- Draft
  const draftLines = [];
  if (member) {
    const aura = auraOf(member);
    if (!aura.missing) draftLines.push(`AURA **${aura.label}**${aura.girl ? ' · 🎀' : ''}`);
  }
  const stats = playerStats(guildId, user.id);
  if (stats) {
    const rate = stats.wins + stats.losses ? ` (${Math.round((100 * stats.wins) / (stats.wins + stats.losses))}%)` : '';
    draftLines.push(
      `${stats.played} tournament(s) · 🏆 **${stats.titles}** · ${stats.wins}W–${stats.losses}L${rate}`,
    );
  }
  if (draftLines.length) embed.addFields({ name: '🎮 Draft', value: draftLines.join('\n') });

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

const data = new SlashCommandBuilder()
  .setName(config.profileRoot)
  .setDescription('Everything SG-BOT knows about a member.')
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('Whose profile (default: you)'));

export const profileCommands = { [config.profileRoot]: { execute } };
export function profileCommandData() {
  return [data.toJSON()];
}
