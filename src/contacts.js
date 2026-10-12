// Member contacts — Instagram handles (/sgig) and phone numbers (/sgphone).
//
// Both work like the birthdays: members save their own, and can remove it again.
// The difference is who may look:
//   /sgig    — public. Anyone can view a handle or list everyone's.
//   /sgphone — private. Only the member themselves and the roles named in
//              PHONE_ROLES (plus the server owner) can see a number, and every
//              reply is ephemeral. There is no public list. With a verify.mn
//              key set, a number is only saved once the member has texted
//              a code from it (see phoneVerify.js).
//
// Saved in data/store.json under guild.contacts.{ig,phone}.

import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, escapeMarkdown } from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import { parseSteamId, steamIdTo64 } from './steamid.js';
import { phoneVerifyOn, isPhoneVerified, verifyAndSavePhone } from './phoneVerify.js';

const LIST_LIMIT = 4000; // embed description budget
const IG_HANDLE = /^[a-zA-Z0-9._]{1,30}$/;

const ephemeral = (interaction, content) =>
  interaction.reply({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } });

const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

/** The member's roles, whichever shape the interaction handed us. */
function rolesOf(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles.map((r) => ({ id: typeof r === 'string' ? r : r.id, name: r.name ?? '' }));
  if (roles.cache) return [...roles.cache.values()].map((r) => ({ id: r.id, name: r.name }));
  return [];
}

/**
 * Who may look at someone else's private contact. PHONE_ROLES names the roles
 * that may — exactly those, not everyone holding Manage Server, which in a
 * server with a dozen moderator and bot roles is far more people than intended.
 * The server owner always may.
 */
function canSeePrivate(interaction) {
  if (!config.phoneRoles.length) return isAdmin(interaction);
  if (interaction.guild?.ownerId && interaction.guild.ownerId === interaction.user.id) return true;
  const wanted = config.phoneRoles.map((r) => r.toLowerCase());
  return rolesOf(interaction).some((r) => wanted.includes(r.id) || wanted.includes((r.name || '').toLowerCase()));
}

/** Named in a refusal, so people know who to ask rather than guessing. */
const whoCanSee = () =>
  config.phoneRoles.length
    ? config.phoneRoles.map((r) => (/^\d{5,}$/.test(r) ? `<@&${r}>` : `**${r}**`)).join(', ')
    : 'admins';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * "@name", "name", "instagram.com/name/", "https://www.instagram.com/name?x=1"
 * -> "name". Returns null if it isn't a possible handle.
 */
export function parseInstagram(input) {
  let text = String(input ?? '').trim();
  const url = text.match(/instagram\.com\/([^/?#\s]+)/i);
  if (url) text = url[1];
  text = text.replace(/^@+/, '').replace(/\/+$/, '').trim();
  return IG_HANDLE.test(text) ? text : null;
}

/**
 * A phone number as typed -> "+97699112233", or null if it can't be one.
 * Accepts a local number of PHONE_LOCAL_DIGITS digits (PHONE_COUNTRY_CODE is
 * added), a number with the country code, "00…" and "+…" international forms.
 */
export function parsePhone(input) {
  const raw = String(input ?? '').trim();
  if (/[a-z]/i.test(raw)) return null; // words, "call me", …
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  const country = config.phoneCountry.replace(/\D/g, '');

  if (/^\+\d+$/.test(digits)) {
    return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null; // E.164
  }
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === config.phoneLocalDigits) return `+${country}${digits}`;
  if (digits.startsWith(country) && digits.length === country.length + config.phoneLocalDigits) {
    return `+${digits}`;
  }
  return null;
}

/** "+97699112233" -> "+976 9911 2233" (local part in two halves when it splits evenly). */
export function formatPhone(stored) {
  const country = config.phoneCountry.replace(/\D/g, '');
  if (!stored.startsWith(`+${country}`)) return stored;
  const local = stored.slice(country.length + 1);
  const half = Math.ceil(local.length / 2);
  return `+${country} ${local.slice(0, half)} ${local.slice(half)}`.trimEnd();
}

/**
 * A Steam profile as typed -> what we store: a SteamID64 ("7656…"), or
 * "id:name" for a custom URL (which needs a Steam API key to resolve, so we
 * keep the name as given). null if it's neither.
 */
export function parseSteam(input) {
  const text = String(input ?? '').trim();
  const vanity = text.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})/i);
  if (vanity) return `id:${vanity[1]}`;
  const id = parseSteamId(text); // SteamID64, STEAM_1:…, [U:1:…], /profiles/… link
  if (id) return steamIdTo64(id);
  return /^[A-Za-z0-9_-]{2,32}$/.test(text) ? `id:${text}` : null; // a bare custom name
}

/** Stored Steam value -> a clickable profile link. */
export function steamLink(stored) {
  return stored.startsWith('id:')
    ? `https://steamcommunity.com/id/${stored.slice(3)}`
    : `https://steamcommunity.com/profiles/${stored}`;
}

// ---------------------------------------------------------------------------
// Shared command handlers
// ---------------------------------------------------------------------------

/**
 * One contact kind. `parse` normalizes what the member typed, `show` renders a
 * stored value (and is told whose it is), and `private` decides whether replies
 * are ephemeral and whether looking someone else up needs Manage Server.
 * `saveVia`, when given, takes over saving a parsed value — it may return
 * nothing to leave it to the ordinary path.
 */
function contact({ kind, root, label, aLabel, plural, emoji, parse, show, hint, isPrivate, saveVia }) {
  const reply = (interaction, content, options = {}) =>
    interaction.reply({
      content,
      allowedMentions: { parse: [] },
      ...(isPrivate ? { flags: MessageFlags.Ephemeral } : {}),
      ...options,
    });

  async function set(interaction) {
    const value = parse(interaction.options.getString('value', true));
    if (!value) return ephemeral(interaction, `❌ That doesn't look like ${aLabel}. ${hint}`);
    const taken = saveVia?.(interaction, value);
    if (taken) return taken;
    store.setContact(interaction.guildId, kind, interaction.user.id, value);
    return ephemeral(interaction, `${emoji} Saved your ${label}: ${show(value)}`);
  }

  async function view(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    const self = target.id === interaction.user.id;
    if (isPrivate && !self && !canSeePrivate(interaction)) {
      return ephemeral(interaction, `🔒 Only ${whoCanSee()} can look up someone else's ${label}.`);
    }
    const value = store.getContacts(interaction.guildId, kind)[target.id];
    if (!value) {
      return ephemeral(
        interaction,
        self ? `You haven't saved ${aLabel} yet.` : `${target} hasn't saved ${aLabel}.`,
      );
    }
    return reply(interaction, `${emoji} ${target} · ${show(value, interaction.guildId, target.id)}`);
  }

  async function remove(interaction) {
    const user = interaction.options.getUser('user');
    if (user && user.id !== interaction.user.id && !isAdmin(interaction)) {
      return ephemeral(interaction, '❌ You need the **Manage Server** permission to remove someone else’s.');
    }
    const target = user || interaction.user;
    const existed = store.removeContact(interaction.guildId, kind, target.id);
    if (kind === 'phone') {
      store.removeContact(interaction.guildId, 'phoneVerified', target.id);
      store.removeContact(interaction.guildId, 'phonePending', target.id);
    }
    return ephemeral(
      interaction,
      existed ? `✅ Removed ${target}'s ${label}.` : `ℹ️ No ${label} saved for ${target}.`,
    );
  }

  async function list(interaction) {
    if (isPrivate && !canSeePrivate(interaction)) {
      return ephemeral(interaction, `🔒 ${plural} are private — only ${whoCanSee()} can list them.`);
    }
    const all = Object.entries(store.getContacts(interaction.guildId, kind));
    if (!all.length) {
      return ephemeral(interaction, `Nobody has saved ${aLabel} yet. Add yours with \`/${root} set\`.`);
    }
    const lines = [];
    let used = 0;
    for (const [id, value] of all) {
      const line = `<@${id}> · ${show(value, interaction.guildId, id)}`;
      if (used + line.length + 1 > LIST_LIMIT - 40) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length < all.length) lines.push(`…and ${all.length - lines.length} more`);

    const embed = new EmbedBuilder()
      .setColor(0xe1306c)
      .setTitle(`${emoji} ${plural}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${all.length} saved${isPrivate ? ' · admins only' : ''}` });
    return interaction.reply({
      embeds: [embed],
      allowedMentions: { parse: [] },
      ...(isPrivate ? { flags: MessageFlags.Ephemeral } : {}),
    });
  }

  const handlers = { set, view, remove, list };

  const data = new SlashCommandBuilder()
    .setName(root)
    .setDescription(`Save and look up ${plural.toLowerCase()}.`)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription(`Save your ${label}.`)
        .addStringOption((o) => o.setName('value').setDescription(hint).setRequired(true).setMaxLength(60)),
    )
    .addSubcommand((s) =>
      s
        .setName('view')
        .setDescription(isPrivate ? `Show a ${label} (yours, or anyone's if you're an admin).` : `Show someone's ${label}.`)
        .addUserOption((o) => o.setName('user').setDescription('Whose (default: you)')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription(`Remove your ${label} (admins can remove anyone's).`)
        .addUserOption((o) => o.setName('user').setDescription("(Admin) Remove someone else's")),
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription(isPrivate ? `(Restricted) Everyone's ${label}.` : `Everyone's ${label}.`),
    );

  return {
    root,
    data,
    execute: (interaction) => handlers[interaction.options.getSubcommand()]?.(interaction),
  };
}

const instagram = contact({
  kind: 'ig',
  root: config.igRoot,
  label: 'Instagram handle',
  aLabel: 'an Instagram handle',
  plural: 'Instagram handles',
  emoji: '📸',
  isPrivate: false,
  hint: 'Your handle, e.g. `secret.garden` or an instagram.com link.',
  parse: parseInstagram,
  show: (handle) => `[@${escapeMarkdown(handle)}](https://instagram.com/${handle})`,
});

const phone = contact({
  kind: 'phone',
  root: config.phoneRoot,
  label: 'phone number',
  aLabel: 'a phone number',
  plural: 'Phone numbers',
  emoji: '📱',
  isPrivate: true,
  hint: phoneVerifyOn()
    ? `Your ${config.phoneLocalDigits}-digit number (e.g. 9911 2233). You confirm it by SMS.`
    : `An ${config.phoneLocalDigits}-digit number (e.g. 9911 2233) or an international one starting with +.`,
  parse: parsePhone,
  // With verification on, whoever may see a number also sees whether it was
  // proven — numbers saved before then stand out as the ones to chase up.
  show: (value, guildId, userId) =>
    `\`${formatPhone(value)}\`` +
    (phoneVerifyOn() && userId ? (isPhoneVerified(guildId, userId) ? ' ✅' : ' ⚠️ not verified') : ''),
  saveVia: (interaction, value) =>
    phoneVerifyOn() ? verifyAndSavePhone(interaction, value, { show: (n) => `\`${formatPhone(n)}\`` }) : null,
});

const steam = contact({
  kind: 'steam',
  root: config.steamRoot,
  label: 'Steam profile',
  aLabel: 'a Steam profile',
  plural: 'Steam profiles',
  emoji: '🎮',
  isPrivate: false,
  hint: 'Your profile link, e.g. steamcommunity.com/id/yourname, or your SteamID.',
  parse: parseSteam,
  show: (value) => `[${value.startsWith('id:') ? escapeMarkdown(value.slice(3)) : value}](${steamLink(value)})`,
});

export const contactCommands = {
  [instagram.root]: { execute: instagram.execute },
  [phone.root]: { execute: phone.execute },
  [steam.root]: { execute: steam.execute },
};

export function contactCommandData() {
  return [instagram.data.toJSON(), phone.data.toJSON(), steam.data.toJSON()];
}

/** What someone has saved, for /sgprofile. */
export function savedContacts(guildId, userId) {
  return {
    ig: store.getContacts(guildId, 'ig')[userId] || null,
    phone: store.getContacts(guildId, 'phone')[userId] || null,
    steam: store.getContacts(guildId, 'steam')[userId] || null,
  };
}
