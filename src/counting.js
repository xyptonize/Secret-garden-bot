// /sgcount — the counting draw.
//
// An admin opens a round over a range, say 1–500. Members count up in order in
// one channel: whoever types the next number claims it, anything else is turned
// away. Each member may claim at most COUNT_DAILY_LIMIT numbers a day. When the
// last number is claimed the bot draws three winners — revealed third, second,
// first, so the biggest prize comes last.
//
// Every claimed number is kept with its owner, so the draw can be audited after
// the fact: the full ledger of who held which number goes into the permanent
// record in data/count-history.json alongside the winners.

import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import { randomInt } from 'node:crypto';
import { config } from './config.js';
import * as store from './store.js';

const PLACES = ['🥇 1st', '🥈 2nd', '🥉 3rd'];
const GOLD = 0xf1c40f;
const GREY = 0x9aa0a6;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
const ephemeral = (interaction, content) => interaction.reply({ flags: MessageFlags.Ephemeral, content });
const number = (n) => Number(n).toLocaleString('en-US');

/** Today, in the server's own timezone — the day a daily limit runs on. */
const dayOf = (at = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: config.caseTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** How many numbers this member has claimed today. */
function claimedToday(round, userId) {
  const today = dayOf();
  let n = 0;
  for (const e of Object.values(round.entries)) if (e.by === userId && e.day === today) n += 1;
  return n;
}

const countOf = (round) => Object.keys(round.entries).length;
const sizeOf = (round) => round.to - round.from + 1;

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * A message in the counting channel. Returns what happened, so the caller can
 * react — and so this can be tested without Discord.
 *
 * The decision and the write happen with no await in between: two members
 * typing the same number at the same moment must not both be able to claim it.
 */
export function offerNumber(guildId, { userId, text, bot }) {
  const round = store.getCounting(guildId);
  if (!round || round.status !== 'open') return { ignore: true };
  if (bot) return { ignore: true };

  // Only a bare number is an attempt to count. Anything else is just chat and
  // is left alone — a counting channel is still a channel.
  const cleaned = String(text ?? '').trim().replace(/[,\s_]/g, '');
  if (!/^\d{1,15}$/.test(cleaned)) return { ignore: true };
  const value = Number(cleaned);

  if (value !== round.next) return { wrong: true, expected: round.next, got: value };
  if (config.countNoDouble && round.last === userId) {
    return { refused: 'twice', message: 'Someone else has to take the next one.' };
  }
  const already = claimedToday(round, userId);
  if (already >= config.countDailyLimit) {
    return { refused: 'limit', message: `That's your ${config.countDailyLimit} for today — back tomorrow.` };
  }

  round.entries[String(value)] = { by: userId, at: new Date().toISOString(), day: dayOf() };
  round.last = userId;
  round.next = value + 1;
  const filled = value >= round.to;
  if (filled) round.status = 'drawing';
  store.setCounting(guildId, round);

  return {
    accepted: true,
    value,
    left: sizeOf(round) - countOf(round),
    remainingToday: config.countDailyLimit - already - 1,
    filled,
    round,
  };
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

/**
 * Three distinct members, drawn from the claimed numbers. Every number is a
 * ticket by default, so counting more often is worth more — set COUNT_WEIGHTED
 * to false for one entry per member however many they claimed.
 *
 * They come out in the order they are drawn, and the caller reveals them
 * backwards: the last one drawn takes first place.
 */
export function drawWinners(round, { weighted = config.countWeighted } = {}) {
  const tickets = Object.entries(round.entries).map(([n, e]) => ({ n: Number(n), by: e.by }));
  if (!tickets.length) return [];

  const pool = weighted
    ? tickets
    : [...new Set(tickets.map((t) => t.by))].map((by) => tickets.find((t) => t.by === by));

  const drawn = [];
  let left = pool;
  while (drawn.length < 3 && left.length) {
    const pick = left[randomInt(0, left.length)];
    drawn.push(pick);
    left = left.filter((t) => t.by !== pick.by); // one prize per member
  }
  return drawn;
}

/**
 * Settle a round: draw, write the permanent record, and hand back the winners.
 * The record is saved before anything is announced, so a failed post can never
 * lose who won.
 */
export function settleRound(guildId, round, { cancelled = false } = {}) {
  const drawn = cancelled ? [] : drawWinners(round);
  // Drawn first → third place, last drawn → first.
  const winners = drawn.map((t, i) => ({
    place: drawn.length - i, // 3rd, 2nd, 1st as they come out
    userId: t.by,
    number: t.n,
    prize: round.prizes?.[drawn.length - i - 1] || null,
  }));

  const history = store.getCountHistory(guildId);
  const record = {
    ...round,
    id: round.id,
    status: cancelled ? 'cancelled' : 'finished',
    endedAt: new Date().toISOString(),
    winners,
    players: new Set(Object.values(round.entries).map((e) => e.by)).size,
    claimed: countOf(round),
  };
  record.players = new Set(Object.values(round.entries).map((e) => e.by)).size;
  history.rounds.push(record);
  store.persistCountHistory();
  store.setCounting(guildId, null);
  return { winners, record };
}

const prizeLine = (w) => `<@${w.userId}> — number **${number(w.number)}**${w.prize ? ` · **${w.prize}**` : ''}`;

/** Reveal 3rd, then 2nd, then 1st in one message that keeps growing. */
export async function announceDraw(channel, record) {
  const { winners } = record;
  const base = () =>
    new EmbedBuilder()
      .setColor(GOLD)
      .setTitle(`🎉 ${record.title} — the draw`)
      .setFooter({
        text: `Round #${record.id} · ${number(record.claimed)} numbers from ${record.players} member(s) · /${config.countRoot} round ${record.id}`,
      });

  const lines = [`Every number from **${number(record.from)}** to **${number(record.to)}** was claimed. Drawing three winners…`];
  const message = await channel.send({ embeds: [base().setDescription(lines.join('\n'))] });

  // Backwards: third place first, the big one last.
  for (const place of [3, 2, 1]) {
    const w = winners.find((x) => x.place === place);
    if (!w) continue;
    await sleep(config.countRevealMs);
    lines.push(`${PLACES[place - 1]} ${prizeLine(w)}`);
    await message
      .edit({
        content: place === 1 ? winners.map((x) => `<@${x.userId}>`).join(' ') : undefined,
        embeds: [base().setDescription(lines.join('\n'))],
        allowedMentions: { users: winners.map((x) => x.userId) },
      })
      .catch(() => {});
  }
  return message;
}

// ---------------------------------------------------------------------------
// The message hook
// ---------------------------------------------------------------------------

/**
 * Called for every message in a guild. Does nothing unless it lands in the
 * channel of an open round.
 */
export async function onCountingMessage(message, client) {
  try {
    const round = message.guildId && store.getCounting(message.guildId);
    if (!round || round.status !== 'open' || message.channelId !== round.channelId) return;

    const result = offerNumber(message.guildId, {
      userId: message.author?.id,
      text: message.content,
      bot: message.author?.bot,
    });
    if (result.ignore) return;

    if (result.accepted) {
      await message.react('✅').catch(() => {});
      if (result.filled) {
        const { record } = settleRound(message.guildId, result.round);
        await announceDraw(message.channel, record).catch((err) => console.error('Draw announcement failed:', err.message));
      }
      return;
    }

    await message.react(result.wrong ? '❌' : '🚫').catch(() => {});
    if (config.countDeleteWrong) await message.delete().catch(() => {});
    if (result.refused) {
      await message.channel
        .send({ content: `<@${message.author.id}> ${result.message}`, allowedMentions: { users: [message.author.id] } })
        .then((m) => setTimeout(() => m.delete().catch(() => {}), 10000))
        .catch(() => {});
    }
  } catch (err) {
    console.error('Counting message failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdOpen(interaction) {
  if (!isAdmin(interaction)) return ephemeral(interaction, '🔒 Only admins (Manage Server) can open a round.');
  if (store.getCounting(interaction.guildId)) {
    return ephemeral(interaction, `❌ A round is already running — close it first with \`/${config.countRoot} close\`.`);
  }
  const from = interaction.options.getInteger('from', true);
  const to = interaction.options.getInteger('to', true);
  if (to <= from) return ephemeral(interaction, '❌ The last number has to be bigger than the first.');
  if (to - from + 1 > 100000) return ephemeral(interaction, '❌ That range is too big — keep it under 100,000 numbers.');

  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (channel.type !== ChannelType.GuildText) return ephemeral(interaction, '❌ Pick a normal text channel.');
  const me = interaction.guild?.members?.me;
  const perms = me && channel.permissionsFor(me);
  if (perms && !perms.has(PermissionFlagsBits.AddReactions)) {
    return ephemeral(interaction, `❌ I need **Add Reactions** in ${channel} to mark numbers right or wrong.`);
  }
  const ping = interaction.options.getString('ping') ?? 'everyone';
  // @everyone renders whether or not the bot may ping, so a missing permission
  // would look like it worked while nobody was actually notified.
  const canPing = !perms || perms.has(PermissionFlagsBits.MentionEveryone);
  const silent = ping !== 'none' && !canPing;

  const history = store.getCountHistory(interaction.guildId);
  const round = {
    id: history.nextId++,
    title: interaction.options.getString('title') || 'Counting draw',
    channelId: channel.id,
    from,
    to,
    next: from,
    last: null,
    prizes: [interaction.options.getString('prize1'), interaction.options.getString('prize2'), interaction.options.getString('prize3')].map((p) => p || null),
    entries: {},
    openedBy: interaction.user.id,
    startedAt: new Date().toISOString(),
    status: 'open',
  };
  store.persistCountHistory();
  store.setCounting(interaction.guildId, round);

  const prizes = round.prizes.some(Boolean)
    ? round.prizes.map((p, i) => `${PLACES[i]} ${p || '—'}`).join('\n')
    : '_Set when the winners are announced._';
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content:
      `✅ Round #${round.id} is open in ${channel}.` +
      (silent ? `\n⚠️ I don't have **Mention @everyone** there, so the announcement will post but won't notify anyone.` : ''),
  });

  const mention = ping === 'everyone' ? '@everyone' : ping === 'here' ? '@here' : '';
  return channel
    .send({
      content: mention
        ? `${mention} 🔢 **Counting is open — ${number(from)} to ${number(to)}!**`
        : `🔢 **Counting is open — ${number(from)} to ${number(to)}!**`,
      allowedMentions: { parse: mention ? ['everyone'] : [] },
      embeds: [
        new EmbedBuilder()
          .setColor(GOLD)
          .setTitle(`🔢 ${round.title}`)
          .setDescription(
            [
              `Count from **${number(from)}** to **${number(to)}** — in order, one number per message.`,
              `Type **${number(from)}** to start. If you type anything other than the next number, it doesn't count.`,
              '',
              `• Up to **${config.countDailyLimit}** numbers each per day`,
              config.countNoDouble ? '• You can\'t take two in a row' : null,
              `• When **${number(to)}** is reached, three of you win — drawn 3rd, 2nd, then 1st`,
              `• Every number you hold is a ticket, so counting more often is worth more`,
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .addFields({ name: '🏆 Prizes', value: prizes })
          .setFooter({ text: `Round #${round.id} · /${config.countRoot} status` }),
      ],
    })
    .catch(() => undefined);
}

function statusEmbed(round, userId) {
  const claimed = countOf(round);
  const size = sizeOf(round);
  const done = Math.round((claimed / size) * 100);
  const bar = '█'.repeat(Math.round(done / 5)).padEnd(20, '░');
  const mine = Object.entries(round.entries).filter(([, e]) => e.by === userId);
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`🔢 ${round.title}`)
    .setDescription(
      [
        `Next number: **${number(round.next)}** in <#${round.channelId}>`,
        `\`${bar}\` ${done}% — ${number(claimed)} of ${number(size)} claimed`,
        `**${number(size - claimed)}** to go before the draw.`,
        '',
        `You hold **${mine.length}** number(s) · **${Math.max(0, config.countDailyLimit - claimedToday(round, userId))}** left today`,
      ].join('\n'),
    )
    .setFooter({ text: `Round #${round.id} · ${new Set(Object.values(round.entries).map((e) => e.by)).size} member(s) counting` });
}

async function cmdStatus(interaction) {
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, `No round is running. An admin can open one with \`/${config.countRoot} open\`.`);
  return interaction.reply({ embeds: [statusEmbed(round, interaction.user.id)] });
}

async function cmdMe(interaction) {
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  const mine = Object.keys(round.entries)
    .filter((n) => round.entries[n].by === interaction.user.id)
    .map(Number)
    .sort((a, b) => a - b);
  if (!mine.length) return ephemeral(interaction, `You haven't claimed a number yet — type **${number(round.next)}** in <#${round.channelId}>.`);
  const shown = mine.slice(0, 60).map(number).join(', ');
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [
      new EmbedBuilder()
        .setColor(GOLD)
        .setTitle(`🎟️ Your ${mine.length} ticket(s)`)
        .setDescription(`${shown}${mine.length > 60 ? ` … and ${mine.length - 60} more` : ''}`)
        .setFooter({ text: `${Math.max(0, config.countDailyLimit - claimedToday(round, interaction.user.id))} left today` }),
    ],
  });
}

async function cmdTop(interaction) {
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  const tally = new Map();
  for (const e of Object.values(round.entries)) tally.set(e.by, (tally.get(e.by) || 0) + 1);
  if (!tally.size) return ephemeral(interaction, 'Nobody has counted yet.');
  const total = countOf(round);
  const lines = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id, n], i) => `**${i + 1}.** <@${id}> — ${n} ticket(s) · ${((100 * n) / total).toFixed(1)}% of the draw`);
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(GOLD).setTitle('🎟️ Who holds the most tickets').setDescription(lines.join('\n'))],
    allowedMentions: { parse: [] },
  });
}

async function cmdClose(interaction) {
  if (!isAdmin(interaction)) return ephemeral(interaction, '🔒 Only admins (Manage Server) can close a round.');
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  if (!countOf(round)) return ephemeral(interaction, `Nobody has counted yet — use \`/${config.countRoot} cancel\` to drop the round.`);

  await interaction.reply({ flags: MessageFlags.Ephemeral, content: `🎲 Drawing round #${round.id} early…` });
  const { record } = settleRound(interaction.guildId, round);
  const channel = await interaction.client.channels.fetch(round.channelId).catch(() => interaction.channel);
  if (channel) await announceDraw(channel, record).catch((err) => console.error('Draw announcement failed:', err.message));
  return undefined;
}

async function cmdCancel(interaction) {
  if (!isAdmin(interaction)) return ephemeral(interaction, '🔒 Only admins (Manage Server) can cancel a round.');
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  const { record } = settleRound(interaction.guildId, round, { cancelled: true });
  return interaction.reply(`🚫 Round #${record.id} cancelled — ${number(record.claimed)} number(s) were claimed, nobody was drawn.`);
}

async function cmdHistory(interaction) {
  const rounds = store.getCountHistory(interaction.guildId).rounds;
  if (!rounds.length) return ephemeral(interaction, 'No rounds have finished yet.');
  const lines = rounds
    .slice(-10)
    .reverse()
    .map((r) => {
      const first = r.winners?.find((w) => w.place === 1);
      return `**#${r.id}** ${r.title} — ${r.status === 'cancelled' ? 'cancelled' : `🥇 <@${first?.userId}>`} · ${number(r.claimed)} numbers · <t:${Math.floor(Date.parse(r.endedAt) / 1000)}:D>`;
    });
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(GOLD).setTitle('🔢 Past rounds').setDescription(lines.join('\n')).setFooter({ text: `/${config.countRoot} round <id> for the full result` })],
    allowedMentions: { parse: [] },
  });
}

async function cmdRound(interaction) {
  const id = interaction.options.getInteger('id', true);
  const record = store.getCountHistory(interaction.guildId).rounds.find((r) => r.id === id);
  if (!record) return ephemeral(interaction, `No round #${id}.`);
  const winners = record.winners?.length
    ? [1, 2, 3].map((place) => {
        const w = record.winners.find((x) => x.place === place);
        return w ? `${PLACES[place - 1]} ${prizeLine(w)}` : null;
      }).filter(Boolean).join('\n')
    : '_Cancelled — no draw._';
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(record.status === 'cancelled' ? GREY : GOLD)
        .setTitle(`🔢 Round #${record.id} — ${record.title}`)
        .setDescription(winners)
        .addFields(
          { name: 'Range', value: `${number(record.from)} – ${number(record.to)}`, inline: true },
          { name: 'Claimed', value: `${number(record.claimed)}`, inline: true },
          { name: 'Members', value: `${record.players}`, inline: true },
        )
        .setFooter({ text: `Drawn ${new Date(record.endedAt).toUTCString()}` }),
    ],
    allowedMentions: { parse: [] },
  });
}

const HANDLERS = {
  open: cmdOpen,
  status: cmdStatus,
  me: cmdMe,
  top: cmdTop,
  close: cmdClose,
  cancel: cmdCancel,
  history: cmdHistory,
  round: cmdRound,
};

async function execute(interaction) {
  const handler = HANDLERS[interaction.options.getSubcommand()];
  return handler ? handler(interaction) : undefined;
}

const data = new SlashCommandBuilder()
  .setName(config.countRoot)
  .setDescription('Counting draw — count up together, three of you win.')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('open')
      .setDescription('(Admin) Start a round over a range of numbers')
      .addIntegerOption((o) => o.setName('from').setDescription('First number').setRequired(true).setMinValue(0))
      .addIntegerOption((o) => o.setName('to').setDescription('Last number — the draw happens when it is reached').setRequired(true).setMinValue(1))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to count (default: here)').addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName('title').setDescription('What to call this round'))
      .addStringOption((o) =>
        o
          .setName('ping')
          .setDescription('Who to notify when it opens (default: @everyone)')
          .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }, { name: 'Nobody', value: 'none' }),
      )
      .addStringOption((o) => o.setName('prize1').setDescription('First prize, e.g. 100,000₮'))
      .addStringOption((o) => o.setName('prize2').setDescription('Second prize'))
      .addStringOption((o) => o.setName('prize3').setDescription('Third prize')),
  )
  .addSubcommand((s) => s.setName('status').setDescription('What number is next and how far along the round is'))
  .addSubcommand((s) => s.setName('me').setDescription('The numbers you hold'))
  .addSubcommand((s) => s.setName('top').setDescription('Who holds the most tickets'))
  .addSubcommand((s) => s.setName('close').setDescription('(Admin) Draw now, without filling the range'))
  .addSubcommand((s) => s.setName('cancel').setDescription('(Admin) Drop the round with no draw'))
  .addSubcommand((s) => s.setName('history').setDescription('Past rounds and their winners'))
  .addSubcommand((s) => s.setName('round').setDescription('One round in full').addIntegerOption((o) => o.setName('id').setDescription('Round number').setRequired(true)));

export const countCommands = { [config.countRoot]: { execute } };
export function countCommandData() {
  return [data.toJSON()];
}
