// /sgcasino — wagering the 🌱 seeds that /sgcase pays out.
//
// The house takes nothing: every payout is the exact inverse of the chance of
// winning (see casinoGames.js), so seeds move between members and the pool
// neither grows nor drains. What protects people is the limits — a ceiling per
// bet and a daily loss cap — not the odds.
//
// A stake leaves the wallet the moment a game starts and the result is written
// before it is shown, the same way an unboxing is. Games that span several
// presses (mines, blackjack) keep their state in the store, so a restart can
// hand the stake back instead of swallowing it.

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import { wallet } from './cases.js';
import * as game from './casinoGames.js';
import { openMatches, findMatch, placeBet, poolOf, teamName } from './betting.js';

const PREFIX = 'sgcs|';
const SEED = '🌱';
const WIN = 0x57f287;
const LOSE = 0xed4245;
const PUSH = 0x9aa0a6;
const TABLE = 0x5865f2;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const money = (n) => `${SEED} **${Math.round(n).toLocaleString('en-US')}**`;
const ephemeral = (interaction, content) => interaction.reply({ flags: MessageFlags.Ephemeral, content });

// Duels that have already been settled, so a double-click can't pay twice.
const settledDuels = new Set();

// ---------------------------------------------------------------------------
// Wallet, limits, bookkeeping
// ---------------------------------------------------------------------------

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: config.caseTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function ledger(p) {
  if (!p.casino) p.casino = { plays: 0, wagered: 0, won: 0, lost: 0, best: 0, lossDate: null, lostToday: 0 };
  const l = p.casino;
  if (l.lossDate !== today()) {
    l.lossDate = today();
    l.lostToday = 0;
  }
  return l;
}

/** How much more they may lose today, or Infinity when there is no cap. */
function lossRoom(p) {
  if (!config.casinoDailyLossCap) return Infinity;
  return Math.max(0, config.casinoDailyLossCap - ledger(p).lostToday);
}

/**
 * Check a bet and take the stake. Returns { p } on success, or { error } with
 * the reason — nothing is deducted unless the bet is good.
 */
function takeStake(guildId, userId, amount) {
  const p = wallet(guildId, userId);
  if (!Number.isInteger(amount) || amount < config.casinoMinBet) {
    return { error: `The smallest bet is ${money(config.casinoMinBet)}.` };
  }
  if (amount > config.casinoMaxBet) {
    return { error: `The biggest bet is ${money(config.casinoMaxBet)}.` };
  }
  if ((p.seeds || 0) < amount) {
    return { error: `You only have ${money(p.seeds || 0)}. Seeds come from \`/${config.caseRoot} daily\`, duplicates, and playing KZ.` };
  }
  if (p.game) {
    return { error: `Finish the ${p.game.kind} you already have running first — \`/${config.casinoRoot} resume\`.` };
  }
  const room = lossRoom(p);
  if (room <= 0) {
    return {
      error:
        `🛑 You've lost ${money(config.casinoDailyLossCap)} today, which is the daily limit. ` +
        'Come back tomorrow — the cap is there so nobody empties their seeds in one sitting.',
    };
  }
  p.seeds -= amount;
  store.persist();
  return { p };
}

/**
 * Book the result of a settled bet. `payout` is what comes back, so 0 is a
 * total loss and `stake` is a push. Written before anything is shown.
 */
function book(p, stake, payout) {
  const l = ledger(p);
  l.plays += 1;
  l.wagered += stake;
  p.seeds = (p.seeds || 0) + payout;
  if (payout > stake) {
    l.won += payout - stake;
    l.best = Math.max(l.best || 0, payout - stake);
  } else if (payout < stake) {
    l.lost += stake - payout;
    l.lostToday += stake - payout;
  }
  store.persist();
  return payout;
}

/** The line under every result: what it did to their balance. */
const balanceLine = (p, stake, payout) => {
  const net = payout - stake;
  const sign = net > 0 ? `+${Math.round(net).toLocaleString('en-US')}` : Math.round(net).toLocaleString('en-US');
  return `${net >= 0 ? '📈' : '📉'} ${sign} ${SEED} · balance ${money(p.seeds || 0)}`;
};

const capFooter = (p) => {
  if (!config.casinoDailyLossCap) return `Fair odds · /${config.casinoRoot} odds`;
  return `Fair odds · ${money(lossRoom(p)).replace(/\*/g, '')} of today's loss limit left`;
};

// ---------------------------------------------------------------------------
// One-shot games
// ---------------------------------------------------------------------------

async function cmdFlip(interaction) {
  const amount = interaction.options.getInteger('amount', true);
  const side = interaction.options.getString('side') || game.SIDES[game.roll(2)];
  const { p, error } = takeStake(interaction.guildId, interaction.user.id, amount);
  if (error) return ephemeral(interaction, `❌ ${error}`);

  const result = game.flip(side);
  const payout = book(p, amount, result.won ? amount * result.multiplier : 0);
  const face = result.landed === 'heads' ? '🪙' : '🌑';
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(result.won ? WIN : LOSE)
        .setTitle(`${face} ${result.landed.toUpperCase()}`)
        .setDescription(
          [
            `You called **${side}** for ${money(amount)}.`,
            result.won ? `✅ Paid **2×** — ${money(payout)}.` : '❌ Lost.',
            balanceLine(p, amount, payout),
          ].join('\n'),
        )
        .setFooter({ text: capFooter(p) }),
    ],
  });
}

async function cmdDice(interaction) {
  const amount = interaction.options.getInteger('amount', true);
  const direction = interaction.options.getString('direction', true);
  const line = interaction.options.getInteger('line', true);
  if (line < game.DICE_MIN || line > game.DICE_MAX) {
    return ephemeral(interaction, `❌ The line has to be between ${game.DICE_MIN} and ${game.DICE_MAX}.`);
  }
  const { p, error } = takeStake(interaction.guildId, interaction.user.id, amount);
  if (error) return ephemeral(interaction, `❌ ${error}`);

  const result = game.dice(direction, line);
  const payout = book(p, amount, result.won ? Math.floor(amount * result.multiplier) : 0);
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(result.won ? WIN : LOSE)
        .setTitle(`🎲 ${result.rolled}`)
        .setDescription(
          [
            `You bet ${money(amount)} on **${direction} ${line}** — ${result.wins} of 100 numbers, paying **${result.multiplier.toFixed(2)}×**.`,
            result.won ? `✅ Paid ${money(payout)}.` : '❌ Lost.',
            balanceLine(p, amount, payout),
          ].join('\n'),
        )
        .setFooter({ text: capFooter(p) }),
    ],
  });
}

async function cmdSlots(interaction) {
  const amount = interaction.options.getInteger('amount', true);
  const { p, error } = takeStake(interaction.guildId, interaction.user.id, amount);
  if (error) return ephemeral(interaction, `❌ ${error}`);

  // Rolled and paid before the animation: a hiccup mid-spin can't cost a win.
  const result = game.slots();
  const payout = book(p, amount, Math.floor(amount * result.multiplier));

  const spinning = () => game.REELS[game.roll(game.REELS.length)];
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(TABLE).setTitle('🎰 Spinning…').setDescription(`# ${spinning()} ${spinning()} ${spinning()}`)],
  });
  await sleep(config.casinoSpinMs);

  const kind = {
    jackpot: `🟡 **JACKPOT** — ${game.SLOT_PAYS.jackpot}×!`,
    triple: `✨ Three of a kind — ${game.SLOT_PAYS.triple}×!`,
    pair: `👌 A pair — ${game.SLOT_PAYS.pair}×.`,
    none: '❌ Nothing.',
  }[result.kind];
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(payout > amount ? WIN : payout === amount ? PUSH : LOSE)
        .setTitle('🎰 Slots')
        .setDescription([`# ${result.reels.join(' ')}`, kind, payout ? `Paid ${money(payout)}.` : '', balanceLine(p, amount, payout)].filter(Boolean).join('\n'))
        .setFooter({ text: capFooter(p) }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Mines — several presses, so the game lives in the store
// ---------------------------------------------------------------------------

function minesView(p, { finished = false, bust = -1 } = {}) {
  const g = p.game;
  const picked = new Set(g.picks);
  const bombs = new Set(g.bombs);
  const now = game.minesMultiplier(g.bombs.length, g.picks.length);
  const next = game.minesMultiplier(g.bombs.length, g.picks.length + 1);

  const rows = [];
  for (let r = 0; r < 4; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 5; c++) {
      const i = r * 5 + c;
      const isBomb = bombs.has(i);
      const shown = picked.has(i) || (finished && isBomb);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}tile|${g.userId}|${i}`)
          .setEmoji(shown ? (isBomb ? '💣' : '💎') : '▫️')
          .setStyle(shown ? (isBomb ? ButtonStyle.Danger : ButtonStyle.Success) : ButtonStyle.Secondary)
          .setDisabled(finished || picked.has(i)),
      );
    }
    rows.push(row);
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}cash|${g.userId}`)
        .setLabel(g.picks.length ? `Cash out ${Math.floor(g.stake * now).toLocaleString('en-US')}` : 'Cash out')
        .setEmoji('💰')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(finished || !g.picks.length),
    ),
  );

  const embed = new EmbedBuilder()
    .setColor(finished ? (bust >= 0 ? LOSE : WIN) : TABLE)
    .setTitle('💣 Mines')
    .setDescription(
      [
        `Stake ${money(g.stake)} · **${g.bombs.length}** bombs in ${game.TILES} tiles`,
        `Found **${g.picks.length}** · worth **${now.toFixed(2)}×** = ${money(Math.floor(g.stake * now))}`,
        finished ? '' : `Next tile pays **${next.toFixed(2)}×**`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  return { embeds: [embed], components: rows };
}

async function cmdMines(interaction) {
  const amount = interaction.options.getInteger('amount', true);
  const bombs = interaction.options.getInteger('bombs') ?? game.MINES_DEFAULT;
  if (bombs < game.MINES_MIN || bombs > game.MINES_MAX) {
    return ephemeral(interaction, `❌ Between ${game.MINES_MIN} and ${game.MINES_MAX} bombs.`);
  }
  const { p, error } = takeStake(interaction.guildId, interaction.user.id, amount);
  if (error) return ephemeral(interaction, `❌ ${error}`);

  p.game = { kind: 'mines', userId: interaction.user.id, stake: amount, bombs: game.layMines(bombs), picks: [] };
  store.persist();
  return interaction.reply(minesView(p));
}

async function minesPick(interaction, userId, index) {
  const p = wallet(interaction.guildId, userId);
  const g = p.game;
  if (!g || g.kind !== 'mines') return ephemeral(interaction, 'That game is over.');
  if (g.picks.includes(index)) return interaction.deferUpdate();

  if (g.bombs.includes(index)) {
    const stake = g.stake;
    g.picks.push(index);
    const view = minesView(p, { finished: true, bust: index });
    delete p.game;
    book(p, stake, 0);
    view.embeds[0]
      .setDescription(`💥 Bomb on tile ${index + 1}. Lost ${money(stake)}.\n${balanceLine(p, stake, 0)}`)
      .setFooter({ text: capFooter(p) });
    return interaction.update(view);
  }

  g.picks.push(index);
  store.persist();
  if (game.minesCleared(g.bombs.length, g.picks.length)) return minesCashOut(interaction, userId, { cleared: true });
  return interaction.update(minesView(p));
}

async function minesCashOut(interaction, userId, { cleared = false } = {}) {
  const p = wallet(interaction.guildId, userId);
  const g = p.game;
  if (!g || g.kind !== 'mines') return ephemeral(interaction, 'That game is over.');
  if (!g.picks.length) return ephemeral(interaction, 'Reveal at least one tile first.');

  const multiplier = game.minesMultiplier(g.bombs.length, g.picks.length);
  const payout = Math.floor(g.stake * multiplier);
  const stake = g.stake;
  const view = minesView(p, { finished: true });
  delete p.game;
  book(p, stake, payout);
  view.embeds[0]
    .setColor(WIN)
    .setDescription(
      [
        cleared ? '🏆 Every safe tile found!' : '💰 Cashed out.',
        `**${g.picks.length}** tiles at **${multiplier.toFixed(2)}×** — ${money(payout)}.`,
        balanceLine(p, stake, payout),
      ].join('\n'),
    )
    .setFooter({ text: capFooter(p) });
  return interaction.update(view);
}

// ---------------------------------------------------------------------------
// Blackjack
// ---------------------------------------------------------------------------

function blackjackView(p, { done = false, note = '' } = {}) {
  const g = p.game;
  const player = game.handValue(g.player);
  const dealer = game.handValue(done ? g.dealer : [g.dealer[0]]);
  const embed = new EmbedBuilder()
    .setColor(done ? (note.startsWith('✅') || note.startsWith('🃏') ? WIN : note.startsWith('🤝') ? PUSH : LOSE) : TABLE)
    .setTitle('🃏 Blackjack')
    .addFields(
      { name: `You — ${player.total}${player.blackjack ? ' (blackjack)' : ''}`, value: g.player.join('  '), inline: true },
      {
        name: done ? `Dealer — ${dealer.total}` : `Dealer — ${dealer.total} + ?`,
        value: done ? g.dealer.join('  ') : `${g.dealer[0]}  🂠`,
        inline: true,
      },
    )
    .setDescription(note || `Stake ${money(g.stake)} — hit or stand?`);

  const rows = done
    ? []
    : [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${PREFIX}hit|${g.userId}`).setLabel('Hit').setEmoji('➕').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${PREFIX}stand|${g.userId}`).setLabel('Stand').setEmoji('✋').setStyle(ButtonStyle.Secondary),
        ),
      ];
  return { embeds: [embed], components: rows };
}

function finishBlackjack(p) {
  const g = p.game;
  g.dealer = game.dealerPlay(g.dealer);
  const result = game.blackjackResult(g.player, g.dealer);
  const stake = g.stake;
  const payout = Math.floor(stake * result.multiplier);
  const note = {
    bust: '❌ Busted.',
    blackjack: '🃏 Blackjack! Paid 3:2.',
    'dealer-blackjack': "❌ Dealer had blackjack.",
    'dealer-bust': '✅ Dealer busted.',
    win: '✅ You win.',
    lose: '❌ Dealer wins.',
    push: '🤝 Push — stake returned.',
  }[result.outcome];
  const view = blackjackView(p, { done: true, note });
  delete p.game;
  book(p, stake, payout);
  view.embeds[0].setDescription(`${note}\n${balanceLine(p, stake, payout)}`).setFooter({ text: capFooter(p) });
  return view;
}

async function cmdBlackjack(interaction) {
  const amount = interaction.options.getInteger('amount', true);
  const { p, error } = takeStake(interaction.guildId, interaction.user.id, amount);
  if (error) return ephemeral(interaction, `❌ ${error}`);

  p.game = { kind: 'blackjack', userId: interaction.user.id, stake: amount, player: [game.draw(), game.draw()], dealer: [game.draw(), game.draw()] };
  store.persist();
  // A natural on either side ends it immediately, as at a real table.
  if (game.handValue(p.game.player).blackjack || game.handValue(p.game.dealer).blackjack) {
    return interaction.reply(finishBlackjack(p));
  }
  return interaction.reply(blackjackView(p));
}

async function blackjackHit(interaction, userId) {
  const p = wallet(interaction.guildId, userId);
  const g = p.game;
  if (!g || g.kind !== 'blackjack') return ephemeral(interaction, 'That hand is over.');
  g.player.push(game.draw());
  store.persist();
  if (game.handValue(g.player).total >= 21) return interaction.update(finishBlackjack(p));
  return interaction.update(blackjackView(p));
}

async function blackjackStand(interaction, userId) {
  const p = wallet(interaction.guildId, userId);
  if (!p.game || p.game.kind !== 'blackjack') return ephemeral(interaction, 'That hand is over.');
  return interaction.update(finishBlackjack(p));
}

// ---------------------------------------------------------------------------
// Duels — member against member, the bot only holds the pot
// ---------------------------------------------------------------------------

async function cmdDuel(interaction) {
  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);
  if (target.id === interaction.user.id) return ephemeral(interaction, "❌ You can't duel yourself.");
  if (target.bot) return ephemeral(interaction, "❌ Bots don't gamble.");

  const p = wallet(interaction.guildId, interaction.user.id);
  if (amount < config.casinoMinBet || amount > config.casinoMaxBet) {
    return ephemeral(interaction, `❌ Stakes run from ${money(config.casinoMinBet)} to ${money(config.casinoMaxBet)}.`);
  }
  if ((p.seeds || 0) < amount) return ephemeral(interaction, `❌ You only have ${money(p.seeds || 0)}.`);

  // Nothing is taken yet: both stakes are collected when the duel is accepted,
  // so a challenge that is ignored costs nobody anything.
  const at = Math.floor(Date.now() / 1000);
  const expires = at + config.casinoDuelMinutes * 60;
  return interaction.reply({
    content: `<@${target.id}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(TABLE)
        .setTitle('⚔️ Coinflip duel')
        .setDescription(
          [
            `<@${interaction.user.id}> stakes ${money(amount)} against <@${target.id}>.`,
            'One flip, winner takes the pot.',
            `Expires <t:${expires}:R>.`,
          ].join('\n'),
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}duelok|${interaction.user.id}|${target.id}|${amount}|${at}`).setLabel('Accept').setEmoji('⚔️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PREFIX}duelno|${interaction.user.id}|${target.id}|${amount}|${at}`).setLabel('Decline').setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { users: [target.id] },
  });
}

async function duelAnswer(interaction, [challengerId, targetId, rawAmount, rawAt], accepted) {
  const amount = Number(rawAmount);
  const at = Number(rawAt) * 1000;
  const key = interaction.customId;

  if (!accepted) {
    if (interaction.user.id !== targetId && interaction.user.id !== challengerId) {
      return ephemeral(interaction, "That duel isn't yours to answer.");
    }
    settledDuels.add(key);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(PUSH).setTitle('⚔️ Duel called off').setDescription(`<@${interaction.user.id}> turned it down. Nothing was staked.`)],
      components: [],
    });
  }

  if (interaction.user.id !== targetId) return ephemeral(interaction, 'Only the challenged member can accept.');
  if (settledDuels.has(key)) return ephemeral(interaction, 'That duel is already settled.');
  if (Date.now() - at > config.casinoDuelMinutes * 60 * 1000) {
    settledDuels.add(key);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(PUSH).setTitle('⚔️ Duel expired').setDescription('Nobody was charged.')],
      components: [],
    });
  }

  const challenger = wallet(interaction.guildId, challengerId);
  const target = wallet(interaction.guildId, targetId);
  const short = (challenger.seeds || 0) < amount ? challengerId : (target.seeds || 0) < amount ? targetId : null;
  if (short) {
    settledDuels.add(key);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(PUSH).setTitle('⚔️ Duel called off').setDescription(`<@${short}> no longer has ${money(amount)}.`)],
      components: [],
    });
  }
  const capped = lossRoom(challenger) <= 0 ? challengerId : lossRoom(target) <= 0 ? targetId : null;
  if (capped) {
    settledDuels.add(key);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(PUSH).setTitle('⚔️ Duel called off').setDescription(`<@${capped}> has hit today's loss limit.`)],
      components: [],
    });
  }

  // Settled, then shown — like every other bet here.
  settledDuels.add(key);
  challenger.seeds -= amount;
  target.seeds -= amount;
  const challengerWins = game.roll(2) === 0;
  const winnerId = challengerWins ? challengerId : targetId;
  book(challenger, amount, challengerWins ? amount * 2 : 0);
  book(target, amount, challengerWins ? 0 : amount * 2);

  return interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(WIN)
        .setTitle('⚔️ Duel')
        .setDescription(
          [
            `<@${challengerId}> vs <@${targetId}> for ${money(amount)} each.`,
            `🪙 **<@${winnerId}> takes the pot** — ${money(amount * 2)}.`,
          ].join('\n'),
        ),
    ],
    components: [],
  });
}

// ---------------------------------------------------------------------------
// Betting on draft matches (pari-mutuel — see betting.js)
// ---------------------------------------------------------------------------

async function cmdBet(interaction) {
  const id = interaction.options.getString('match', true);
  const team = Number(interaction.options.getString('team', true));
  const amount = interaction.options.getInteger('amount', true);
  const p = wallet(interaction.guildId, interaction.user.id);
  if (lossRoom(p) <= 0) {
    return ephemeral(interaction, `🛑 You've hit today's loss limit of ${money(config.casinoDailyLossCap)}. Back tomorrow.`);
  }

  const { error, match, staked, pool } = placeBet(interaction.guildId, interaction.user.id, id, team, amount);
  if (error) return ephemeral(interaction, `❌ ${error}`);

  const sides = match.teams
    .map((t) => `${teamName(t)} ${money(pool.byTeam.get(t) || 0)}`)
    .join(' · ');
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(TABLE)
        .setTitle('🏆 Bet placed')
        .setDescription(
          [
            `<@${interaction.user.id}> backs **${teamName(team)}** with ${money(amount)}${staked > amount ? ` (${money(staked)} in total)` : ''}.`,
            `_${match.label}_`,
            '',
            `**Pot ${money(pool.total)}** — ${sides}`,
            'Winners split the whole pot in proportion to their stake.',
          ].join('\n'),
        )
        .setFooter({ text: capFooter(p) }),
    ],
    allowedMentions: { parse: [] },
  });
}

async function cmdBets(interaction) {
  const open = openMatches(interaction.guildId);
  if (!open.length) {
    return ephemeral(interaction, `No matches to bet on right now — betting opens when a host starts a bracket in \`/${config.draftRoot}\`.`);
  }
  const lines = open.slice(0, 20).map((m) => {
    const pool = poolOf(m.lobby, m.round, m.match);
    const sides = m.teams.map((t) => `${teamName(t)} ${Math.round(pool.byTeam.get(t) || 0).toLocaleString('en-US')}`).join(' vs ');
    const mine = pool.bets[interaction.user.id];
    return `**${m.label}**\n${SEED} ${sides}${mine ? ` · you: ${money(mine.amount)} on ${teamName(mine.team)}` : ''}`;
  });
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [
      new EmbedBuilder()
        .setColor(TABLE)
        .setTitle('🏆 Open matches')
        .setDescription(lines.join('\n\n').slice(0, 4000))
        .setFooter({ text: `Bet with /${config.casinoRoot} bet · stakes are returned if a bracket is cancelled` }),
    ],
  });
}

/** Suggestions for `match:` and `team:` — only what can still be backed. */
export async function handleCasinoAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const open = openMatches(interaction.guildId);
  if (focused.name === 'match') {
    const typed = String(focused.value ?? '').toLowerCase();
    return interaction
      .respond(
        open
          .filter((m) => m.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((m) => ({ name: m.label.slice(0, 100), value: m.id.slice(0, 100) })),
      )
      .catch(() => {});
  }
  if (focused.name === 'team') {
    const match = open.find((m) => m.id === interaction.options.getString('match'));
    const choices = (match?.teams ?? []).map((t) => ({ name: teamName(t), value: String(t) }));
    return interaction.respond(choices).catch(() => {});
  }
  return interaction.respond([]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Status, odds, and recovery
// ---------------------------------------------------------------------------

async function cmdStats(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const stored = store.getCardProfiles(interaction.guildId)[user.id];
  const l = stored?.casino;
  if (!l?.plays) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `${user.id === interaction.user.id ? "You haven't" : `<@${user.id}> hasn't`} placed a bet yet. Try \`/${config.casinoRoot} flip\`.`,
      allowedMentions: { parse: [] },
    });
  }
  const net = (l.won || 0) - (l.lost || 0);
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(net >= 0 ? WIN : LOSE)
        .setTitle(`🎲 ${user.displayName || user.username} at the table`)
        .setDescription(
          [
            `Balance ${money(stored.seeds || 0)}`,
            `Bets **${l.plays.toLocaleString('en-US')}** · wagered ${money(l.wagered || 0)}`,
            `Won ${money(l.won || 0)} · lost ${money(l.lost || 0)}`,
            `${net >= 0 ? '📈 Up' : '📉 Down'} ${money(Math.abs(net))} overall · best win ${money(l.best || 0)}`,
          ].join('\n'),
        )
        .setFooter({ text: capFooter(stored) }),
    ],
    allowedMentions: { parse: [] },
  });
}

async function cmdOdds(interaction) {
  const mines = [1, 3, 5].map((b) => `${b} bomb${b > 1 ? 's' : ''}: ${[1, 3, 5].map((k) => `${k}→${game.minesMultiplier(b, k).toFixed(2)}×`).join(', ')}`);
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [
      new EmbedBuilder()
        .setColor(TABLE)
        .setTitle('🎲 The odds')
        .setDescription(
          `The house takes **nothing**. Every payout below is the exact inverse of its chance, so on average a bet returns exactly what it cost. ${SEED} seeds only move between members.`,
        )
        .addFields(
          { name: '🪙 Coinflip', value: '50% to double. Pays **2×**.' },
          { name: '🎲 Dice', value: 'Roll 1–100 and call over or under a line. Pays **100 ÷ winning numbers** — e.g. over 60 wins 40 times in 100 and pays **2.50×**.' },
          {
            name: '🎰 Slots',
            value: `7 symbols, 3 reels. Pair **${game.SLOT_PAYS.pair}×** (36.7%) · any triple **${game.SLOT_PAYS.triple}×** (1.7%) · 🟡🟡🟡 **${game.SLOT_PAYS.jackpot}×** (0.29%). Expected return **${game.slotsReturn().toFixed(2)}**.`,
          },
          { name: '💣 Mines', value: `${game.TILES} tiles. Each safe tile raises the multiplier; cash out whenever.\n${mines.join('\n')}` },
          { name: '🃏 Blackjack', value: `Blackjack pays 3:2, dealer draws to 17.\n_${game.EDGE_NOTE}_` },
          {
            name: '⚔️ Duels & 🏆 match bets',
            value: `Member against member — the bot only holds the pot and hands over every seed of it.`,
          },
        )
        .setFooter({ text: `Bets ${config.casinoMinBet}–${config.casinoMaxBet} 🌱 · rolls use a cryptographic random source` }),
    ],
  });
}

async function cmdResume(interaction) {
  const p = wallet(interaction.guildId, interaction.user.id);
  if (!p.game) return ephemeral(interaction, `You have no game running. Start one with \`/${config.casinoRoot} mines\`.`);
  return interaction.reply(p.game.kind === 'mines' ? minesView(p) : blackjackView(p));
}

/**
 * Hand back the stake of any game that was still running when the bot stopped.
 * The alternative is a member losing a stake to a restart, which is the one
 * outcome the table should never produce.
 */
export function refundInterruptedGames() {
  let refunded = 0;
  for (const [guildId, g] of Object.entries(store.allGuilds())) {
    for (const [userId, p] of Object.entries(g.cards || {})) {
      if (!p.game) continue;
      p.seeds = (p.seeds || 0) + p.game.stake;
      console.log(`↩️  Refunded ${p.game.stake} seeds to ${userId} in ${guildId}: their ${p.game.kind} game was interrupted.`);
      delete p.game;
      refunded += 1;
    }
  }
  if (refunded) store.persist();
  return refunded;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export const isCasinoComponent = (interaction) => Boolean(interaction.customId?.startsWith(PREFIX));

export async function handleCasinoComponent(interaction) {
  const [action, ...rest] = interaction.customId.slice(PREFIX.length).split('|');
  if (action === 'duelok' || action === 'duelno') return duelAnswer(interaction, rest, action === 'duelok');

  const [ownerId, arg] = rest;
  if (ownerId !== interaction.user.id) {
    return ephemeral(interaction, `That's someone else's game — start your own with \`/${config.casinoRoot}\`.`);
  }
  if (action === 'tile') return minesPick(interaction, ownerId, Number(arg));
  if (action === 'cash') return minesCashOut(interaction, ownerId);
  if (action === 'hit') return blackjackHit(interaction, ownerId);
  if (action === 'stand') return blackjackStand(interaction, ownerId);
  return undefined;
}

const HANDLERS = {
  flip: cmdFlip,
  dice: cmdDice,
  slots: cmdSlots,
  mines: cmdMines,
  blackjack: cmdBlackjack,
  duel: cmdDuel,
  stats: cmdStats,
  odds: cmdOdds,
  resume: cmdResume,
  bet: cmdBet,
  bets: cmdBets,
};

async function execute(interaction) {
  const handler = HANDLERS[interaction.options.getSubcommand()];
  return handler ? handler(interaction) : undefined;
}

const bet = (o, description = 'How many seeds to stake') =>
  o.setName('amount').setDescription(description).setRequired(true).setMinValue(config.casinoMinBet).setMaxValue(config.casinoMaxBet);

const data = new SlashCommandBuilder()
  .setName(config.casinoRoot)
  .setDescription('Wager your seeds — fair odds, no house edge.')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('flip')
      .setDescription('Coinflip — 50/50 to double your stake')
      .addIntegerOption(bet)
      .addStringOption((o) =>
        o.setName('side').setDescription('Heads or tails (default: random)').addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('dice')
      .setDescription('Roll 1–100 and call over or under')
      .addIntegerOption(bet)
      .addStringOption((o) =>
        o.setName('direction').setDescription('Over or under the line').setRequired(true).addChoices({ name: 'Over', value: 'over' }, { name: 'Under', value: 'under' }),
      )
      .addIntegerOption((o) => o.setName('line').setDescription('The line, 1–99').setRequired(true).setMinValue(game.DICE_MIN).setMaxValue(game.DICE_MAX)),
  )
  .addSubcommand((s) => s.setName('slots').setDescription('Three reels — pairs, triples and a jackpot').addIntegerOption(bet))
  .addSubcommand((s) =>
    s
      .setName('mines')
      .setDescription('Reveal safe tiles and cash out before you hit a bomb')
      .addIntegerOption(bet)
      .addIntegerOption((o) => o.setName('bombs').setDescription(`How many bombs (${game.MINES_MIN}–${game.MINES_MAX}, default ${game.MINES_DEFAULT})`).setMinValue(game.MINES_MIN).setMaxValue(game.MINES_MAX)),
  )
  .addSubcommand((s) => s.setName('blackjack').setDescription('Play a hand against the dealer').addIntegerOption(bet))
  .addSubcommand((s) =>
    s
      .setName('duel')
      .setDescription('Challenge a member to a coinflip for seeds')
      .addUserOption((o) => o.setName('user').setDescription('Who to challenge').setRequired(true))
      .addIntegerOption((o) => bet(o, 'What each of you stakes')),
  )
  .addSubcommand((s) =>
    s
      .setName('bet')
      .setDescription('Back a team in a running draft match')
      .addStringOption((o) => o.setName('match').setDescription('Which match').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('team').setDescription('Which team').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => bet(o, 'How many seeds to put on them')),
  )
  .addSubcommand((s) => s.setName('bets').setDescription('Matches you can bet on, and what is riding on them'))
  .addSubcommand((s) => s.setName('resume').setDescription('Show the game you left running'))
  .addSubcommand((s) => s.setName('stats').setDescription('Your record at the table').addUserOption((o) => o.setName('user').setDescription('Someone else')))
  .addSubcommand((s) => s.setName('odds').setDescription('Every payout, and the chance behind it'));

export const casinoCommands = { [config.casinoRoot]: { execute } };
export function casinoCommandData() {
  return [data.toJSON()];
}
