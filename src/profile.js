// /sgprofile — everything SG-BOT knows about a member, on one card:
// their Discord standing in the server, what they've saved (birthday, socials,
// Steam), their CS2KZ ratings and their draft record.
//
// The reply is public, so a saved phone number is never printed — it only shows
// as "saved (private)". Use /sgphone view for the number itself.

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags,
} from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import * as kz from './kzApi.js';
import { savedContacts, steamLink, parseInstagram, parsePhone, parseSteam, formatPhone } from './contacts.js';
import { steamIdTo64 } from './steamid.js';
import { parseBirthdayText, birthdayLabel } from './birthday.js';
import { rankFor } from './ranks.js';
import { formatNumber } from './format.js';
import { globalStandingText } from './commands.js';
import { playerStats } from './draftHistory.js';
import { auraOf } from './draft.js';
import { renderCard } from './cards.js';
import { equippedBackground, walletOf, profileCardRow } from './cases.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const TOP_ROLES = 4;

const day = (ms) => `<t:${Math.floor(ms / 1000)}:D>`;
const shortDate = (ms) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "14 March", or "14 March 1999 · 27" when the year is known. */
function birthdayText(b) {
  const date = `${b.day} ${MONTHS[b.month - 1]}`;
  if (!b.year) return date;
  const now = new Date();
  const had = now.getMonth() + 1 > b.month || (now.getMonth() + 1 === b.month && now.getDate() >= b.day);
  return `${date} ${b.year} · ${now.getFullYear() - b.year - (had ? 0 : 1)}`;
}

const PREFIX = 'sgp|'; // buttons on your own card
const MODAL = 'sgpm|'; // the pop-up forms they open

/** What each button saves, and how it reads what was typed. */
const FIELDS = {
  bday: {
    emoji: '🎂',
    label: 'Birthday',
    hint: 'e.g. 14/03 or 14 March 1999',
    parse: parseBirthdayText,
    save: (guildId, id, v) => store.setBirthday(guildId, id, v),
    show: (v) => birthdayLabel(v),
  },
  ig: {
    emoji: '📸',
    label: 'Instagram',
    hint: 'e.g. secret.garden or an instagram.com link',
    parse: parseInstagram,
    save: (guildId, id, v) => store.setContact(guildId, 'ig', id, v),
    show: (v) => `@${v}`,
  },
  steam: {
    emoji: '🎮',
    label: 'Steam',
    hint: 'e.g. steamcommunity.com/id/yourname, or your SteamID',
    parse: parseSteam,
    save: (guildId, id, v) => store.setContact(guildId, 'steam', id, v),
    show: (v) => steamLink(v),
  },
  phone: {
    emoji: '📱',
    label: 'Phone',
    hint: 'e.g. 9911 2233 — only you and admins can see it',
    parse: parsePhone,
    save: (guildId, id, v) => store.setContact(guildId, 'phone', id, v),
    show: (v) => formatPhone(v),
  },
};

/** Buttons under your own card: one per thing you can fill in. */
function fillButtons(guildId, userId) {
  const saved = savedContacts(guildId, userId);
  const has = { bday: store.getBirthdays(guildId)[userId], ig: saved.ig, steam: saved.steam, phone: saved.phone };
  const kzSteam = store.findByDiscord(guildId, userId)?.steamId;
  const row = new ActionRowBuilder();
  for (const [kind, field] of Object.entries(FIELDS)) {
    // Registered with /sgkz but no Steam profile saved: offer it in one click.
    const oneClick = kind === 'steam' && !has.steam && kzSteam;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}${oneClick ? 'usekz' : kind}|${userId}`)
        .setEmoji(field.emoji)
        .setLabel(oneClick ? 'Use my KZ Steam' : has[kind] ? `Change ${field.label.toLowerCase()}` : `Add ${field.label.toLowerCase()}`)
        .setStyle(has[kind] ? ButtonStyle.Secondary : ButtonStyle.Primary),
    );
  }
  return [row];
}

async function buildProfile(interaction, user) {
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

  // --- CS2KZ (kept for the card as well as the embed)
  let kzData = null;
  let kzStanding = null;
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
      kzData = data;
      kzStanding = standing;
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
  const aura = member ? auraOf(member) : null;
  if (aura && !aura.missing) draftLines.push(`AURA **${aura.label}**${aura.girl ? ' · 🎀' : ''}`);
  const stats = playerStats(guildId, user.id);
  if (stats) {
    const rate = stats.wins + stats.losses ? ` (${Math.round((100 * stats.wins) / (stats.wins + stats.losses))}%)` : '';
    draftLines.push(
      `${stats.played} tournament(s) · 🏆 **${stats.titles}** · ${stats.wins}W–${stats.losses}L${rate}`,
    );
  }
  if (draftLines.length) embed.addFields({ name: '🎮 Draft', value: draftLines.join('\n') });

  // --- Their unlocked card background
  const wallet = walletOf(guildId, user.id);
  if (wallet) {
    embed.addFields({
      name: '🎒 Cards',
      value: `Collected **${wallet.have}/${wallet.total}** backgrounds · 🎁 **${wallet.cases}** case(s) · 🌱 **${wallet.seeds}** seeds`,
    });
  }

  const own = user.id === interaction.user.id;
  const components = own ? [...fillButtons(guildId, user.id), profileCardRow(guildId, user.id)] : [];
  const files = [];

  // The card is decoration: if drawing it fails, the embed still answers.
  try {
    const subtitle = [];
    if (aura && !aura.missing) subtitle.push(`AURA ${aura.label}${aura.girl ? ' 🎀' : ''}`);
    if (member?.joinedTimestamp) subtitle.push(`Joined ${shortDate(member.joinedTimestamp)}`);
    if (birthday) subtitle.push(`🎂 ${birthday.day} ${MONTHS[birthday.month - 1].slice(0, 3)}`);

    const cells = [];
    if (kzData) cells.push({ label: 'CKZ Rating', value: formatNumber(kzData.ckz_rating ?? 0) });
    if (kzStanding?.rank) cells.push({ label: 'Global', value: `#${formatNumber(kzStanding.rank)}` });
    if (stats) {
      cells.push({ label: 'Tournaments', value: `${stats.played} · 🏆 ${stats.titles}` });
      cells.push({ label: 'Draft W–L', value: `${stats.wins}–${stats.losses}` });
    }
    if (!cells.length) {
      if (member?.joinedTimestamp) cells.push({ label: 'Member since', value: shortDate(member.joinedTimestamp) });
      if (wallet) cells.push({ label: 'Backgrounds', value: `${wallet.have}/${wallet.total}` });
    }

    const png = await renderCard({
      background: equippedBackground(guildId, user.id),
      name: member?.displayName || user.globalName || user.username,
      subtitle: subtitle.join(' · '),
      avatarUrl: avatar,
      stats: cells,
    });
    files.push(new AttachmentBuilder(png, { name: 'card.png' }));
    embed.setImage('attachment://card.png');
  } catch (err) {
    console.error('Profile card render failed:', err.message);
  }

  return {
    embeds: [embed],
    components,
    files,
    // The card is re-rendered when a field is filled in; without this the old
    // card.png stays attached next to the new one.
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

async function execute(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  await interaction.deferReply();
  return interaction.editReply(await buildProfile(interaction, user));
}

export const isProfileButton = (interaction) => interaction.customId?.startsWith(PREFIX);
export const isProfileModal = (interaction) => interaction.customId?.startsWith(MODAL);

/** A button on someone's card: either the one-click Steam copy, or a form. */
export async function handleProfileButton(interaction) {
  const [kind, ownerId] = interaction.customId.slice(PREFIX.length).split('|');
  if (ownerId !== interaction.user.id) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `That's someone else's profile — run \`/${config.profileRoot}\` to fill in your own.`,
    });
  }

  if (kind === 'usekz') {
    const steamId = store.findByDiscord(interaction.guildId, ownerId)?.steamId;
    const id64 = steamId && steamIdTo64(steamId);
    if (!id64) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "You aren't registered with /sgkz." });
    }
    store.setContact(interaction.guildId, 'steam', ownerId, id64);
    await interaction.deferUpdate();
    await interaction.editReply(await buildProfile(interaction, interaction.user));
    return interaction
      .followUp({ flags: MessageFlags.Ephemeral, content: `🎮 Saved your Steam profile: ${steamLink(id64)}` })
      .catch(() => {});
  }

  const field = FIELDS[kind];
  if (!field) return undefined;
  const modal = new ModalBuilder().setCustomId(`${MODAL}${kind}|${ownerId}`).setTitle(`${field.emoji} ${field.label}`);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field.label)
        .setPlaceholder(field.hint.slice(0, 100))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(60),
    ),
  );
  return interaction.showModal(modal);
}

/** The form came back: save it and refresh the card underneath. */
export async function handleProfileModal(interaction) {
  const [kind, ownerId] = interaction.customId.slice(MODAL.length).split('|');
  const field = FIELDS[kind];
  if (!field || ownerId !== interaction.user.id) return undefined;

  const value = field.parse(interaction.fields.getTextInputValue('value'));
  if (!value) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `❌ I couldn't read that ${field.label.toLowerCase()} — ${field.hint}.`,
    });
  }
  field.save(interaction.guildId, ownerId, value);
  await interaction.deferUpdate();
  await interaction.editReply(await buildProfile(interaction, interaction.user)).catch(() => {});
  return interaction
    .followUp({ flags: MessageFlags.Ephemeral, content: `${field.emoji} Saved: ${field.show(value)}` })
    .catch(() => {});
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
