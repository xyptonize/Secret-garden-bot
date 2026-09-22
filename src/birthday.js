// Birthday reminders — everything under /sghb (BIRTHDAY_COMMAND_ROOT).
//
// Members save their own day + month (year optional, only used to show the
// age). From BIRTHDAY_HOUR in BIRTHDAY_TIMEZONE the bot posts in the birthday
// channel. Who has been greeted today is stored, so a restart never posts twice,
// and someone added later that day (or a channel set later) is still greeted.

import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const CHECK_INTERVAL_MS = 60 * 1000;
const UNKNOWN_MEMBER = 10007;
const warnedNoChannel = new Set(); // "guild|date" already warned about a missing channel

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Current date and hour in the configured timezone. */
function localNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: config.birthdayTimeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, Number(p.value)]),
  );
  const iso = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, iso };
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (month, year) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The date a birthday is celebrated in a given year (29 Feb → 28 Feb in non-leap years). */
function celebratedDay(b, year) {
  return b.month === 2 && b.day === 29 && !isLeap(year) ? 28 : b.day;
}

function isToday(b, today) {
  return b.month === today.month && celebratedDay(b, today.year) === today.day;
}

/** Days from today until the next celebration (0 = today). */
function daysUntil(b, today) {
  const start = Date.UTC(today.year, today.month - 1, today.day);
  let next = Date.UTC(today.year, b.month - 1, celebratedDay(b, today.year));
  if (next < start) next = Date.UTC(today.year + 1, b.month - 1, celebratedDay(b, today.year + 1));
  return Math.round((next - start) / 86400000);
}

const formatDate = (b) => `${b.day} ${MONTHS[b.month - 1]}`;

/**
 * A date typed as free text -> { day, month, year|null }, or null.
 * Accepts "14/3", "14.03.1999", "14-3-99", "14 March", "March 14" and "14 March 1999".
 */
export function parseBirthdayText(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  let day = null;
  let month = null;
  let year = null;

  const named = MONTHS.findIndex((m) => text.includes(m.toLowerCase().slice(0, 3)));
  const numbers = text.match(/\d{1,4}/g)?.map(Number) ?? [];
  if (named >= 0) {
    month = named + 1;
    day = numbers.find((n) => n >= 1 && n <= 31) ?? null;
    year = numbers.find((n) => n >= 1900 && n <= new Date().getFullYear()) ?? null;
  } else {
    [day, month] = numbers;
    year = numbers[2] ?? null;
    if (year != null && year < 100) year += year > 30 ? 1900 : 2000; // "99" -> 1999
  }
  if (!day || !month || month < 1 || month > 12) return null;
  if (year != null && (year < 1900 || year > new Date().getFullYear())) return null;
  if (day > daysInMonth(month, year ?? 2000)) return null;
  return { day, month, year: year ?? null };
}

/** "14 March 1999" for a saved birthday — shared with /sgprofile. */
export const birthdayLabel = (b) => `${formatDate(b)}${b.year ? ` ${b.year}` : ''}`;
const formatFull = (b) => `**${formatDate(b)}**${b.year ? ` ${b.year}` : ''}`;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function requireAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  interaction
    .reply({ flags: MessageFlags.Ephemeral, content: '❌ You need the **Manage Server** permission for this.' })
    .catch(() => {});
  return false;
}

/**
 * Read day/month/year options; returns { birthday, keptYear } or { error }.
 * Leaving `year` empty keeps whatever was saved before — re-entering the same
 * date (a common way to check it stuck) must not quietly erase the year.
 */
function readBirthday(interaction, existing) {
  const day = interaction.options.getInteger('day', true);
  const month = interaction.options.getInteger('month', true);
  const year = interaction.options.getInteger('year');
  // Check against a leap year so 29 February is accepted without a year.
  if (day > daysInMonth(month, year ?? 2000)) {
    return { error: `❌ ${MONTHS[month - 1]} doesn't have ${day} days${year ? ` in ${year}` : ''}.` };
  }
  const keptYear = year == null && existing?.year != null;
  return { birthday: { day, month, year: year ?? existing?.year ?? null }, keptYear };
}

/** "…; the year you saved is kept" — so nobody thinks the year was dropped. */
const keptNote = (kept, root) =>
  kept ? `\n_Kept the year you saved. To clear it, use \`/${root} remove\` and set it again._` : '';

async function setOwn(interaction) {
  const existing = store.getBirthdays(interaction.guildId)[interaction.user.id];
  const { birthday, keptYear, error } = readBirthday(interaction, existing);
  if (error) return interaction.reply({ flags: MessageFlags.Ephemeral, content: error });
  store.setBirthday(interaction.guildId, interaction.user.id, birthday);
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: `🎂 Saved your birthday as ${formatFull(birthday)}.${keptNote(keptYear, config.birthdayRoot)}`,
  });
}

async function setFor(interaction) {
  if (!requireAdmin(interaction)) return;
  const user = interaction.options.getUser('user', true);
  const existing = store.getBirthdays(interaction.guildId)[user.id];
  const { birthday, keptYear, error } = readBirthday(interaction, existing);
  if (error) return interaction.reply({ flags: MessageFlags.Ephemeral, content: error });
  store.setBirthday(interaction.guildId, user.id, birthday);
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: `🎂 Saved ${user}'s birthday as ${formatFull(birthday)}.${keptNote(keptYear, config.birthdayRoot)}`,
    allowedMentions: { parse: [] },
  });
}

async function remove(interaction) {
  const user = interaction.options.getUser('user');
  if (user && user.id !== interaction.user.id && !requireAdmin(interaction)) return;
  const target = user || interaction.user;
  const existed = store.removeBirthday(interaction.guildId, target.id);
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: existed ? `✅ Removed ${target}'s birthday.` : `ℹ️ No birthday saved for ${target}.`,
    allowedMentions: { parse: [] },
  });
}

async function list(interaction) {
  const today = localNow();
  const entries = Object.entries(store.getBirthdays(interaction.guildId))
    .map(([id, b]) => ({ id, b, days: daysUntil(b, today) }))
    .sort((a, b) => a.days - b.days);

  const embed = new EmbedBuilder().setColor(0xff69b4).setTitle('🎂 Upcoming birthdays');
  if (!entries.length) {
    embed.setDescription(`No birthdays saved yet. Add yours with \`/${config.birthdayRoot} set\`.`);
  } else {
    const lines = entries.slice(0, 25).map(({ id, b, days }) => {
      const when = days === 0 ? '🎉 **today!**' : days === 1 ? 'tomorrow' : `in ${days} days`;
      return `**${formatDate(b)}** · <@${id}> · ${when}`;
    });
    embed.setDescription(lines.join('\n'));
    if (entries.length > 25) embed.setFooter({ text: `Showing the next 25 of ${entries.length}` });
  }
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function setChannel(interaction) {
  if (!requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type)) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: '❌ Run this in a normal text channel, or pick one with the `channel` option.',
    });
  }
  const perms = channel.permissionsFor(interaction.guild.members.me);
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (!needed.every((bit) => perms?.has(bit))) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `❌ I can't post in ${channel} — give me **View Channel, Send Messages and Embed Links** there first.`,
    });
  }
  store.setBirthdayChannel(interaction.guildId, channel.id);
  const hour = String(config.birthdayHour).padStart(2, '0');
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: `✅ Birthday reminders will be posted in ${channel} at ${hour}:00 (${config.birthdayTimeZone}).`,
  });
}

const monthOption = (o) =>
  o
    .setName('month')
    .setDescription('Month')
    .setRequired(true)
    .addChoices(...MONTHS.map((name, i) => ({ name, value: i + 1 })));
const dayOption = (o) => o.setName('day').setDescription('Day of the month').setRequired(true).setMinValue(1).setMaxValue(31);
const yearOption = (o) =>
  o
    .setName('year')
    .setDescription('Birth year (optional — only used to show the age)')
    .setMinValue(1900)
    .setMaxValue(new Date().getFullYear());

const rootBuilder = new SlashCommandBuilder()
  .setName(config.birthdayRoot)
  .setDescription('Birthday reminders.')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Save your birthday.')
      .addIntegerOption(dayOption)
      .addIntegerOption(monthOption)
      .addIntegerOption(yearOption),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove your birthday (admins can remove anyone’s).')
      .addUserOption((o) => o.setName('user').setDescription('(Admin) whose birthday to remove')),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Upcoming birthdays in this server.'))
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('(Admin) Save someone else’s birthday.')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption(dayOption)
      .addIntegerOption(monthOption)
      .addIntegerOption(yearOption),
  )
  .addSubcommand((s) =>
    s
      .setName('setchannel')
      .setDescription('(Admin) Set where birthday reminders are posted.')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Birthday channel (defaults to this one)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  );

const handlers = { set: setOwn, remove, list, add: setFor, setchannel: setChannel };

export const birthdayCommands = {
  [config.birthdayRoot]: {
    execute: (interaction) => handlers[interaction.options.getSubcommand()]?.(interaction),
  },
};

export function birthdayCommandData() {
  return [rootBuilder.toJSON()];
}

// ---------------------------------------------------------------------------
// Daily announcement
// ---------------------------------------------------------------------------

function birthdayEmbed(people, today) {
  const lines = people.map(({ id, b }) => {
    const age = b.year ? today.year - b.year : null;
    return `🎉 <@${id}>${age && age > 0 ? ` turns **${age}**` : ''}`;
  });
  return new EmbedBuilder()
    .setColor(0xff69b4)
    .setTitle(people.length > 1 ? '🎂 Happy birthday to you all!' : '🎂 Happy birthday!')
    .setDescription(lines.join('\n'))
    .setTimestamp();
}

/** Post today's birthdays for one server. Returns true once the day is done with. */
/**
 * Greet today's birthdays not greeted yet. Returns the ids now handled (posted,
 * or skipped because they left) — [] if nothing could be done, so the next
 * minute's check tries again.
 */
async function announceGuild(client, guildId, g, today, done) {
  const channelId = g.birthdayChannelId || config.birthdayChannelId;
  const due = Object.entries(g.birthdays || {})
    .filter(([id, b]) => isToday(b, today) && !done.includes(id))
    .map(([id, b]) => ({ id, b }));
  if (!due.length) return [];
  if (!channelId) {
    if (!warnedNoChannel.has(`${guildId}|${today.iso}`)) {
      warnedNoChannel.add(`${guildId}|${today.iso}`);
      console.warn(`Birthdays: ${due.length} birthday(s) today in ${guildId} but no channel is set — run /${config.birthdayRoot} setchannel.`);
    }
    return [];
  }

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    console.error(`Birthdays: cannot fetch guild ${guildId}:`, err.message);
    return [];
  }

  // Skip people who have left the server; keep them if Discord just didn't answer.
  const present = [];
  for (const p of due) {
    try {
      // Fresh, not cached: the cache still holds people who left.
      await guild.members.fetch({ user: p.id, force: true });
      present.push(p);
    } catch (err) {
      if (err.code !== UNKNOWN_MEMBER) present.push(p);
    }
  }
  if (!present.length) return due.map((p) => p.id);

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({
      content: present.map((p) => `<@${p.id}>`).join(' '),
      embeds: [birthdayEmbed(present, today)],
      allowedMentions: { users: present.map((p) => p.id) },
    });
    return due.map((p) => p.id); // including anyone skipped for having left
  } catch (err) {
    // Not marked done, so the next check retries.
    console.error(`Birthdays: failed to post in ${guildId} (will retry):`, err.message);
    return [];
  }
}

async function check(client) {
  const today = localNow();
  if (today.hour < config.birthdayHour) return;

  for (const [guildId, g] of Object.entries(store.allGuilds())) {
    // Upgrade day: the old marker for today means everyone due was already handled.
    if (g.birthdayLastRun === today.iso && g.birthdayPosted?.date !== today.iso) continue;
    const done = g.birthdayPosted?.date === today.iso ? g.birthdayPosted.ids : [];
    const handled = await announceGuild(client, guildId, g, today, done);
    if (handled.length) store.setBirthdayPosted(guildId, today.iso, [...done, ...handled]);
  }
}

export function startBirthdayScheduler(client) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await check(client);
    } catch (err) {
      console.error('Birthday check failed:', err);
    } finally {
      running = false;
    }
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
  const hour = String(config.birthdayHour).padStart(2, '0');
  console.log(`🎂 Birthday reminders at ${hour}:00 ${config.birthdayTimeZone}.`);
}
