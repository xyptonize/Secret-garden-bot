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

const warnedCannotDelete = new Set(); // one log line per channel, not per message
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

/**
 * Why a strike was given. Members deserve to know which mistake cost them, and
 * "you were too slow" is a very different thing from "you weren't counting".
 */
export const STRIKE_REASONS = {
  late: (d) => `**${number(d.got)}** was already taken — someone got there first`,
  skip: (d) => `wrote **${number(d.got)}** when the next number was **${number(d.expected)}**`,
  chat: () => 'wrote something that wasn\'t a number',
};
export const strikeText = (s) => (STRIKE_REASONS[s.reason] || (() => s.reason))(s);

/** Every strike against one member this round, oldest first. */
export const strikeList = (round, userId) => {
  const held = round.strikes?.[userId];
  return Array.isArray(held) ? held : [];
};
export const strikesOf = (round, userId) => strikeList(round, userId).length;
export const isOut = (round, userId) => config.countStrikes > 0 && strikesOf(round, userId) >= config.countStrikes;

/** Add a strike, with the reason it was given. */
function strike(round, userId, reason, detail = {}) {
  if (!config.countStrikes) return { strikes: 0, out: false };
  if (!round.strikes) round.strikes = {};
  if (!Array.isArray(round.strikes[userId])) round.strikes[userId] = [];
  const was = isOut(round, userId);
  const entry = { reason, at: new Date().toISOString(), ...detail };
  round.strikes[userId].push(entry);
  const out = isOut(round, userId);
  return { strikes: round.strikes[userId].length, out, justOut: !was && out, reason, why: strikeText(entry) };
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

  // Only a bare number is an attempt to count. Anything else is chat, which the
  // caller clears out so the channel stays a clean run of numbers.
  const cleaned = String(text ?? '').trim().replace(/[,\s_]/g, '');
  if (!/^\d{1,15}$/.test(cleaned)) {
    if (!config.countChatStrikes) return { chat: true };
    const s = strike(round, userId, 'chat', { text: String(text ?? '').slice(0, 60) });
    store.setCounting(guildId, round);
    return { chat: true, ...s };
  }
  const value = Number(cleaned);

  if (value !== round.next) {
    // Behind the count is the connection-lag case: the number was already
    // claimed while their message was in flight. Ahead of it is not counting.
    const reason = value < round.next ? 'late' : 'skip';
    const s = strike(round, userId, reason, { got: value, expected: round.next });
    store.setCounting(guildId, round);
    return { wrong: true, expected: round.next, got: value, ...s };
  }
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
 * Three draws, no more: a member who has struck out can still be drawn, and
 * when they are, that prize is simply not given — it does not roll on to
 * somebody else. Picks come back in the order they were drawn, and the first
 * one drawn takes third place.
 */
export function drawWinners(round, { weighted = config.countWeighted } = {}) {
  const tickets = Object.entries(round.entries).map(([n, e]) => ({ n: Number(n), by: e.by }));
  if (!tickets.length) return [];

  const pool = weighted
    ? tickets
    : [...new Set(tickets.map((t) => t.by))].map((by) => tickets.find((t) => t.by === by));

  const picks = [];
  let left = pool;
  while (picks.length < 3 && left.length) {
    const pick = left[randomInt(0, left.length)];
    picks.push({ ...pick, out: isOut(round, pick.by) });
    left = left.filter((t) => t.by !== pick.by); // one result per member
  }
  return picks;
}

/**
 * Settle a round: draw, write the permanent record, and hand back the winners.
 * The record is saved before anything is announced, so a failed post can never
 * lose who won.
 */
export function settleRound(guildId, round, { cancelled = false } = {}) {
  // Claim the round before doing anything with it. A fill is announced over
  // several awaits, and an admin pressing close in that window would otherwise
  // draw it a second time: two records, two announcements, two sets of winners.
  const live = store.getCounting(guildId);
  if (!live || live.settling || (round && live.id !== round.id)) return null;
  live.settling = true;
  round = live;

  const picks = cancelled ? [] : drawWinners(round);
  // Drawn first → third place, last drawn → first.
  const results = picks.map((t, i) => ({
    place: picks.length - i, // 3rd, 2nd, 1st as they come out
    userId: t.by,
    number: t.n,
    prize: round.prizes?.[picks.length - i - 1] || null,
    forfeited: Boolean(t.out),
    strikes: strikesOf(round, t.by),
  }));
  // A place drawn by someone who struck out is not awarded at all — the prize
  // is lost, not handed down.
  const winners = results.filter((r) => !r.forfeited).map(({ forfeited, strikes, ...w }) => w);
  const unlucky = results.filter((r) => r.forfeited);

  const history = store.getCountHistory(guildId);
  const { settling, ...saved } = round;
  const record = {
    ...saved,
    id: round.id,
    status: cancelled ? 'cancelled' : 'finished',
    endedAt: new Date().toISOString(),
    winners,
    unlucky,
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

  const lines = [`Every number from **${number(record.from)}** to **${number(record.to)}** was claimed. Drawing…`];
  const message = await channel.send({ embeds: [base().setDescription(lines.join('\n'))] });

  // Third place first, the big one last. A place drawn by someone who struck
  // out is announced as lost — it is not passed on to anyone else.
  const unlucky = record.unlucky || [];
  for (const place of [3, 2, 1]) {
    const w = winners.find((x) => x.place === place);
    const u = unlucky.find((x) => x.place === place);
    if (!w && !u) continue;
    await sleep(config.countRevealMs);
    lines.push(
      w
        ? `${PLACES[place - 1]} ${prizeLine(w)}`
        : `${PLACES[place - 1]} 💀 **UNLUCKY** — <@${u.userId}> held **${number(u.number)}** but struck out ${u.strikes} times.` +
          `\n⠀⠀${u.prize ? `**${u.prize}** goes unclaimed` : 'No prize awarded'} — it isn't passed on.`,
    );
    await message
      .edit({
        content: place === 1 && winners.length ? winners.map((x) => `<@${x.userId}>`).join(' ') : undefined,
        embeds: [base().setDescription(lines.join('\n'))],
        allowedMentions: { users: [...winners, ...unlucky].map((x) => x.userId) },
      })
      .catch(() => {});
  }

  if (unlucky.length) {
    lines.push('', `⚠️ ${unlucky.length} prize(s) went unclaimed — ${winners.length} winner(s) this round.`);
    await message.edit({ embeds: [base().setDescription(lines.join('\n'))] }).catch(() => {});
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
// When each member was last reminded that the channel is numbers only, so a
// chatty evening doesn't turn into the bot talking to itself.
const reminded = new Map();
const NOTICE_COOLDOWN_MS = 60 * 1000;

function shouldRemind(userId) {
  const last = reminded.get(userId) || 0;
  if (Date.now() - last < NOTICE_COOLDOWN_MS) return false;
  if (reminded.size > 200) reminded.clear();
  reminded.set(userId, Date.now());
  return true;
}

/** Say something in the channel and take it back a few seconds later. */
async function fleeting(channel, content, userId, ms = 8000) {
  const sent = await channel
    .send({ content, allowedMentions: { users: userId ? [userId] : [] } })
    .catch(() => null);
  if (sent) setTimeout(() => sent.delete().catch(() => {}), ms);
}

/**
 * Tell a member what a strike was for. The one that puts them out stays in the
 * channel — it changes what the round means for them — and the rest take
 * themselves back. Once they're out there is nothing new to say, so that is
 * kept to one note a minute.
 */
async function strikeNotice(message, result, round, prefix = '') {
  if (!result.strikes) return;
  const who = `<@${message.author.id}>`;
  const why = result.why ? ` — ${result.why}` : '';
  const next = `The next number is **${number(round.next)}**.`;

  if (result.justOut) {
    await message.channel
      .send({
        content:
          `💀 ${who} is **out of the prize draw** — ${config.countStrikes} strikes${why}.\n` +
          'You can keep counting, but a number of yours can no longer win this round.',
        allowedMentions: { users: [message.author.id] },
      })
      .catch(() => {});
    return;
  }
  if (result.out) {
    // Already out: no need to narrate every further slip.
    if (shouldRemind(message.author.id)) await fleeting(message.channel, `${who} you're out of this round's draw. ${next}`, message.author.id);
    return;
  }
  await fleeting(
    message.channel,
    `${who} ${prefix || 'Wrong number'}${why} — **strike ${result.strikes}/${config.countStrikes}**. ${next}`,
    message.author.id,
  );
}

export async function onCountingMessage(message, client) {
  try {
    const round = message.guildId && store.getCounting(message.guildId);
    if (!round || round.status !== 'open' || message.channelId !== round.channelId) return;
    // Pins, joins and the like are Discord's own messages, not someone chatting.
    if (message.system) return;
    // No text and nothing attached is not something a member can actually post.
    // It is, however, exactly what every message looks like if the Message
    // Content privilege is ever revoked — and treating that as chat would
    // delete the channel and strike out the whole server in one evening.
    const posted = (message.attachments?.size ?? 0) > 0 || (message.stickers?.size ?? 0) > 0 || (message.embeds?.length ?? 0) > 0;
    if (!String(message.content ?? '').trim() && !posted) return;

    const result = offerNumber(message.guildId, {
      userId: message.author?.id,
      text: message.content,
      bot: message.author?.bot,
    });
    if (result.ignore) return;

    // Anything that isn't a number: the channel is for counting only.
    if (result.chat) {
      if (config.countNumbersOnly) {
        const gone = await message.delete().then(() => true).catch(() => false);
        if (!gone && !warnedCannotDelete.has(message.channelId)) {
          warnedCannotDelete.add(message.channelId);
          console.warn(`Counting channel ${message.channelId}: cannot delete chat — I need Manage Messages there.`);
        }
      }
      // Whether or not the message could be removed, a strike was given — and a
      // strike nobody is told about is one they can't learn from.
      await strikeNotice(message, result, round, 'This channel is for counting only');
      return;
    }

    if (result.accepted) {
      // Settled first, reacted second: nothing may come between claiming the
      // last number and the round being drawn.
      const settled = result.filled ? settleRound(message.guildId, result.round) : null;
      await message.react('✅').catch(() => {});
      if (settled) {
        await announceDraw(message.channel, settled.record).catch((err) => console.error('Draw announcement failed:', err.message));
      }
      return;
    }

    await message.react(result.wrong ? '❌' : '🚫').catch(() => {});
    if (config.countDeleteWrong) await message.delete().catch(() => {});
    if (result.refused) await fleeting(message.channel, `<@${message.author.id}> ${result.message}`, message.author.id, 10000);

    await strikeNotice(message, result, round);
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
  if (config.countNumbersOnly && perms && !perms.has(PermissionFlagsBits.ManageMessages)) {
    return ephemeral(
      interaction,
      `❌ I need **Manage Messages** in ${channel} to keep it numbers-only.\n` +
        'Give me that permission there, or set `COUNT_NUMBERS_ONLY=false` to let people chat in the counting channel.',
    );
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
              config.countNumbersOnly ? '• **Numbers only** here — anything else is removed' : null,
              config.countStrikes
                ? `• **${config.countStrikes} strikes and you're out** — a wrong number${config.countChatStrikes ? ', or writing anything that isn\'t a number,' : ''} costs one. That includes being beaten to a number by someone faster, so read before you type.`
                : null,
              config.countStrikes ? '• Struck out? You can still count, but your numbers can no longer win — and if one is drawn, that prize is lost, not passed on.' : null,
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
        config.countStrikes
          ? isOut(round, userId)
            ? `💀 You are **out of the prize draw** — ${strikesOf(round, userId)} strikes.`
            : `Strikes: **${strikesOf(round, userId)}/${config.countStrikes}**`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
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
  const mineStrikes = strikeList(round, interaction.user.id);
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [
      new EmbedBuilder()
        .setColor(GOLD)
        .setTitle(`🎟️ Your ${mine.length} ticket(s)`)
        .setDescription(
          `${shown}${mine.length > 60 ? ` … and ${mine.length - 60} more` : ''}` +
            (mineStrikes.length
              ? `\n\n**Your strikes**\n${mineStrikes.map((x, i) => `${i + 1}. ${strikeText(x)}`).join('\n')}`
              : ''),
        )
        .setFooter({
          text:
            `${Math.max(0, config.countDailyLimit - claimedToday(round, interaction.user.id))} left today` +
            (config.countStrikes
              ? isOut(round, interaction.user.id)
                ? ` · 💀 out of the draw (${strikesOf(round, interaction.user.id)} strikes)`
                : ` · ${strikesOf(round, interaction.user.id)}/${config.countStrikes} strikes`
              : ''),
        }),
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
    .map(([id, n], i) =>
      isOut(round, id)
        ? `**${i + 1}.** <@${id}> — ${n} ticket(s) · 💀 **out** (${strikesOf(round, id)} strikes)`
        : `**${i + 1}.** <@${id}> — ${n} ticket(s) · ${((100 * n) / total).toFixed(1)}% of the draw`,
    );
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(GOLD).setTitle('🎟️ Who holds the most tickets').setDescription(lines.join('\n'))],
    allowedMentions: { parse: [] },
  });
}

async function cmdStrikes(interaction) {
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  if (!config.countStrikes) return ephemeral(interaction, 'Strikes are turned off for this server.');
  const all = Object.entries(round.strikes || {})
    .map(([id]) => [id, strikesOf(round, id)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!all.length) return interaction.reply({ embeds: [new EmbedBuilder().setColor(GOLD).setTitle('✅ Nobody has a strike yet').setDescription('Keep it that way.')] });
  const lines = all
    .slice(0, 12)
    .map(([id]) => {
      const list = strikeList(round, id);
      const head = `${isOut(round, id) ? '💀' : '⚠️'} <@${id}> — **${list.length}/${config.countStrikes}**${isOut(round, id) ? ' · out of the draw' : ''}`;
      return [head, ...list.slice(0, 5).map((x) => `⠀⠀• ${strikeText(x)}`)].join('\n');
    });
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(GOLD)
        .setTitle('⚠️ Strikes')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${config.countStrikes} strikes and a number of yours can no longer win · wrong numbers only` }),
    ],
    allowedMentions: { parse: [] },
  });
}

async function cmdForgive(interaction) {
  if (!isAdmin(interaction)) return ephemeral(interaction, '🔒 Only admins (Manage Server) can clear strikes.');
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  const user = interaction.options.getUser('user', true);
  const had = strikesOf(round, user.id);
  if (!had) return ephemeral(interaction, `<@${user.id}> has no strikes.`);
  const wasOut = isOut(round, user.id);
  delete round.strikes[user.id];
  store.setCounting(interaction.guildId, round);
  return interaction.reply({
    content: `✅ Cleared <@${user.id}>'s ${had} strike(s)${wasOut ? ' — they can win again.' : '.'}`,
    allowedMentions: { users: [user.id] },
  });
}

async function cmdClose(interaction) {
  if (!isAdmin(interaction)) return ephemeral(interaction, '🔒 Only admins (Manage Server) can close a round.');
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  if (round.status !== 'open') return ephemeral(interaction, '⏳ That round is being drawn right now.');
  if (!countOf(round)) return ephemeral(interaction, `Nobody has counted yet — use \`/${config.countRoot} cancel\` to drop the round.`);

  await interaction.reply({ flags: MessageFlags.Ephemeral, content: `🎲 Drawing round #${round.id} early…` });
  const settled = settleRound(interaction.guildId, round);
  if (!settled) return undefined; // something else drew it first
  const channel = await interaction.client.channels.fetch(round.channelId).catch(() => interaction.channel);
  if (channel) await announceDraw(channel, settled.record).catch((err) => console.error('Draw announcement failed:', err.message));
  return undefined;
}

async function cmdCancel(interaction) {
  if (!isAdmin(interaction)) return ephemeral(interaction, '🔒 Only admins (Manage Server) can cancel a round.');
  const round = store.getCounting(interaction.guildId);
  if (!round) return ephemeral(interaction, 'No round is running.');
  if (round.status !== 'open') return ephemeral(interaction, '⏳ That round is being drawn right now.');
  const settled = settleRound(interaction.guildId, round, { cancelled: true });
  if (!settled) return ephemeral(interaction, 'That round was just settled.');
  const { record } = settled;
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
  const results = [1, 2, 3]
    .map((place) => {
      const w = record.winners?.find((x) => x.place === place);
      if (w) return `${PLACES[place - 1]} ${prizeLine(w)}`;
      const u = record.unlucky?.find((x) => x.place === place);
      if (u) return `${PLACES[place - 1]} 💀 UNLUCKY — <@${u.userId}> held ${number(u.number)}, ${u.strikes} strikes · not awarded`;
      return null;
    })
    .filter(Boolean)
    .join('\n');
  const winners = results || '_Cancelled — no draw._';
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
  strikes: cmdStrikes,
  forgive: cmdForgive,
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
  .addSubcommand((s) => s.setName('strikes').setDescription('Who has strikes, and who can no longer win'))
  .addSubcommand((s) =>
    s
      .setName('forgive')
      .setDescription('(Admin) Clear a member\'s strikes')
      .addUserOption((o) => o.setName('user').setDescription('Who to forgive').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('close').setDescription('(Admin) Draw now, without filling the range'))
  .addSubcommand((s) => s.setName('cancel').setDescription('(Admin) Drop the round with no draw'))
  .addSubcommand((s) => s.setName('history').setDescription('Past rounds and their winners'))
  .addSubcommand((s) => s.setName('round').setDescription('One round in full').addIntegerOption((o) => o.setName('id').setDescription('Round number').setRequired(true)));

export const countCommands = { [config.countRoot]: { execute } };
export function countCommandData() {
  return [data.toJSON()];
}
