// /sgalarm — reminders, delivered twice over.
//
// Every alarm goes to the channel it was set in *and* to the member's DMs, so
// one of them getting through is enough: a channel can be deleted, DMs can be
// closed, and neither should be the reason somebody misses the thing they
// asked to be reminded about.
//
// A due alarm is rescheduled (or removed) and written to disk BEFORE it is
// sent. A restart in the middle can therefore lose the message, which is
// recoverable, but can never fire the same alarm twice, which is not.

import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import { parseWhen } from './when.js';

const MAX_MESSAGE = 200;
const LATE_GRACE_MS = 60 * 60 * 1000; // older than this and it's announced as late
const REPEATS = { once: 0, daily: 86400000, weekly: 604800000 };

const ephemeral = (interaction, content) =>
  interaction.reply({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } });
const stamp = (ms) => `<t:${Math.floor(ms / 1000)}:f> (<t:${Math.floor(ms / 1000)}:R>)`;
const repeatText = (r) => (r === 'daily' ? ' · repeats daily' : r === 'weekly' ? ' · repeats weekly' : '');

/** The next free id for this server's alarms. Ids are only reused once an alarm is gone. */
function nextId(alarms) {
  return alarms.reduce((n, a) => Math.max(n, a.id), 0) + 1;
}

const mine = (guildId, userId) => store.getAlarms(guildId).filter((a) => a.userId === userId);

// ---------------------------------------------------------------------------
// Setting one
// ---------------------------------------------------------------------------

async function cmdSet(interaction) {
  const whenText = interaction.options.getString('when', true);
  const message = (interaction.options.getString('about') || '').slice(0, MAX_MESSAGE);
  const repeat = interaction.options.getString('repeat') || 'once';
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  const parsed = parseWhen(whenText, config.alarmTimeZone);
  if (!parsed) {
    return ephemeral(
      interaction,
      `❌ I couldn't read **${whenText}** as a time. Try \`30m\`, \`2h\`, \`1h30m\`, \`21:00\`, \`tomorrow 09:00\`, \`14/03 21:00\` or \`2026-12-25 18:00\`.`,
    );
  }
  const soonest = Date.now() + config.alarmMinSeconds * 1000;
  if (parsed.at < soonest) {
    return ephemeral(interaction, `❌ That's too soon — set it at least ${Math.round(config.alarmMinSeconds / 60) || 1} minute(s) ahead.`);
  }
  if (parsed.at > Date.now() + 365 * 86400000) {
    return ephemeral(interaction, "❌ That's more than a year away.");
  }
  const held = mine(interaction.guildId, interaction.user.id);
  if (held.length >= config.alarmMaxPer) {
    return ephemeral(interaction, `❌ You already have ${held.length} alarms waiting (the limit is ${config.alarmMaxPer}). Cancel one first.`);
  }

  const alarms = store.getAlarms(interaction.guildId);
  const alarm = {
    id: nextId(alarms),
    userId: interaction.user.id,
    channelId: channel.id,
    at: parsed.at,
    message,
    repeat: repeat in REPEATS ? repeat : 'once',
    createdAt: Date.now(),
  };
  alarms.push(alarm);
  store.setAlarms(interaction.guildId, alarms);

  return ephemeral(
    interaction,
    `⏰ Alarm **#${alarm.id}** set for ${stamp(alarm.at)}${repeatText(alarm.repeat)}.\n` +
      `I'll post in <#${channel.id}> and DM you${message ? ` — _${message}_` : ''}.\n` +
      `_(If your DMs are closed you'll still get the channel message.)_`,
  );
}

async function cmdList(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const held = mine(interaction.guildId, user.id).sort((a, b) => a.at - b.at);
  if (!held.length) {
    return ephemeral(
      interaction,
      user.id === interaction.user.id
        ? `No alarms waiting. Set one with \`/${config.alarmRoot} set when:30m\`.`
        : `<@${user.id}> has no alarms waiting.`,
    );
  }
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`⏰ ${held.length} alarm(s)`)
        .setDescription(
          held
            .map((a) => `**#${a.id}** — ${stamp(a.at)}${repeatText(a.repeat)}\n<#${a.channelId}>${a.message ? ` · _${a.message}_` : ''}`)
            .join('\n\n')
            .slice(0, 4000),
        )
        .setFooter({ text: `/${config.alarmRoot} cancel <id> to remove one` }),
    ],
  });
}

async function cmdCancel(interaction) {
  const id = interaction.options.getInteger('id', true);
  const alarms = store.getAlarms(interaction.guildId);
  const alarm = alarms.find((a) => a.id === id && a.userId === interaction.user.id);
  if (!alarm) return ephemeral(interaction, `No alarm **#${id}** of yours. \`/${config.alarmRoot} list\` shows them.`);
  store.setAlarms(interaction.guildId, alarms.filter((a) => a !== alarm));
  return ephemeral(interaction, `🗑️ Alarm **#${alarm.id}** cancelled (was for ${stamp(alarm.at)}).`);
}

async function cmdClear(interaction) {
  const held = mine(interaction.guildId, interaction.user.id);
  if (!held.length) return ephemeral(interaction, 'You have no alarms waiting.');
  store.setAlarms(interaction.guildId, store.getAlarms(interaction.guildId).filter((a) => a.userId !== interaction.user.id));
  return ephemeral(interaction, `🗑️ Cancelled all ${held.length} of your alarms.`);
}

/** Suggestions for `cancel id:` — your own alarms, soonest first. */
export async function handleAlarmAutocomplete(interaction) {
  const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
  const held = mine(interaction.guildId, interaction.user.id)
    .sort((a, b) => a.at - b.at)
    .filter((a) => !typed || String(a.id).startsWith(typed) || a.message.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((a) => ({
      name: `#${a.id} · ${new Date(a.at).toLocaleString('en-GB', { timeZone: config.alarmTimeZone, dateStyle: 'short', timeStyle: 'short' })}${a.message ? ` · ${a.message}` : ''}`.slice(0, 100),
      value: a.id,
    }));
  return interaction.respond(held).catch(() => {});
}

// ---------------------------------------------------------------------------
// Ringing
// ---------------------------------------------------------------------------

function alarmEmbed(alarm, late) {
  const embed = new EmbedBuilder()
    .setColor(late ? 0xe67e22 : 0x5865f2)
    .setTitle('⏰ Alarm')
    .setDescription(alarm.message || '_No note — you just asked to be reminded._')
    .setFooter({ text: `#${alarm.id}${repeatText(alarm.repeat)}${late ? ' · late, the bot was offline' : ''}` });
  return embed;
}

/**
 * Send one alarm to the channel and to the member. Returns how it went, so a
 * member whose DMs are shut can be told once, in the channel, rather than
 * silently missing half of what they asked for.
 */
async function ring(client, guildId, alarm, late) {
  const embed = alarmEmbed(alarm, late);
  let dmed = false;
  try {
    const user = await client.users.fetch(alarm.userId);
    await user.send({ embeds: [embed], content: `⏰ Your alarm${late ? ' (late — I was offline)' : ''}` });
    dmed = true;
  } catch {
    // DMs closed, or the account is gone. The channel copy still goes out.
  }
  try {
    const channel = await client.channels.fetch(alarm.channelId);
    await channel.send({
      content: `<@${alarm.userId}>${dmed ? '' : " _(I couldn't DM you — your DMs are closed.)_"}`,
      embeds: [embed],
      allowedMentions: { users: [alarm.userId] },
    });
    return true;
  } catch {
    return dmed; // the DM alone still counts as delivered
  }
}

/**
 * Fire everything due. A repeating alarm is moved to its next occurrence —
 * skipping any it slept through, so a week offline doesn't produce seven
 * copies — and a one-off is removed. Both are saved before anything is sent.
 */
export async function tick(client, now = Date.now()) {
  let rung = 0;
  for (const [guildId, g] of Object.entries(store.allGuilds())) {
    const alarms = g.alarms || [];
    const due = alarms.filter((a) => a.at <= now);
    if (!due.length) continue;

    const keep = [];
    const sending = [];
    for (const alarm of alarms) {
      if (alarm.at > now) {
        keep.push(alarm);
        continue;
      }
      const late = now - alarm.at > LATE_GRACE_MS;
      sending.push({ alarm: { ...alarm }, late });
      const step = REPEATS[alarm.repeat] || 0;
      if (step) {
        // Catch up to the next future occurrence in one go.
        const missed = Math.floor((now - alarm.at) / step) + 1;
        keep.push({ ...alarm, at: alarm.at + missed * step });
      }
    }
    store.setAlarms(guildId, keep); // written before a single one is sent

    for (const { alarm, late } of sending) {
      const ok = await ring(client, guildId, alarm, late).catch(() => false);
      if (!ok) console.error(`Alarm #${alarm.id} in ${guildId}: couldn't reach ${alarm.userId} in channel or DM.`);
      rung += 1;
    }
  }
  return rung;
}

export function startAlarms(client) {
  const every = config.alarmCheckSeconds * 1000;
  const loop = async () => {
    try {
      await tick(client);
    } catch (err) {
      console.error('Alarm tick failed:', err.message);
    }
    setTimeout(loop, every);
  };
  setTimeout(loop, 2000); // let the client settle first
  console.log(`⏰ Alarms checked every ${config.alarmCheckSeconds}s (${config.alarmTimeZone}).`);
}

// ---------------------------------------------------------------------------

const HANDLERS = { set: cmdSet, list: cmdList, cancel: cmdCancel, clear: cmdClear };

async function execute(interaction) {
  const handler = HANDLERS[interaction.options.getSubcommand()];
  return handler ? handler(interaction) : undefined;
}

const data = new SlashCommandBuilder()
  .setName(config.alarmRoot)
  .setDescription('Set a reminder — the bot posts in the channel and DMs you.')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Set an alarm')
      .addStringOption((o) => o.setName('when').setDescription('30m · 2h · 1h30m · 21:00 · tomorrow 09:00 · 14/03 21:00').setRequired(true))
      .addStringOption((o) => o.setName('about').setDescription('What to remind you about').setMaxLength(MAX_MESSAGE))
      .addStringOption((o) =>
        o
          .setName('repeat')
          .setDescription('Ring again after it goes off')
          .addChoices({ name: 'Once', value: 'once' }, { name: 'Every day', value: 'daily' }, { name: 'Every week', value: 'weekly' }),
      )
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)')),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Your alarms').addUserOption((o) => o.setName('user').setDescription("Someone else's")))
  .addSubcommand((s) =>
    s
      .setName('cancel')
      .setDescription('Cancel one of your alarms')
      .addIntegerOption((o) => o.setName('id').setDescription('Which one').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((s) => s.setName('clear').setDescription('Cancel all of your alarms'));

export const alarmCommands = { [config.alarmRoot]: { execute } };
export function alarmCommandData() {
  return [data.toJSON()];
}
